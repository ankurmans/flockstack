import { DISCOVERY_MAXIMUMS } from "../briefing-rules.js";
import { checkLinks, claimChecks, codeChecks, renderedLinks } from "./check.js";
import { extractOneLiner, extractStory } from "./extract.js";
import { BudgetStop } from "./meter.js";
import { NO_SECTION, assignPrompt, assignTypeSafe, sectionWritePrompt } from "./prompts.js";
import { ProviderError, isAuthFailure } from "./providers.js";
import { citesOf, labelOrigins, languageName, linkCitations, parseDraft, sanitizeModelMarkdown } from "./write.js";

// A sectioned briefing (models/Briefing.js sections): the issue is a fixed, labelled skeleton of sections in reading order, each
// with its purpose, format (prose sentences or sourced one-liners), item cap, share of the extract and write budget and
// priority. After triage every shortlisted story is assigned to one section (or none); sections are filled in priority order up
// to their caps, the lead taking the best story overall; each item is extracted at the size its format needs; each section is
// written from its own records; the sections are rendered in reading order under their titles. When money runs short the
// sections are written in priority order and the rest are skipped_budget. Without sections nothing here runs.
export function isSectioned(briefing) {
	return Array.isArray(briefing?.sections) && briefing.sections.length > 0;
}

// The sections with their reading order, priority (unset: after the set ones, in reading order) and share (unset: an equal part of
// what the set shares leave).
export function sectionsOf(briefing) {
	const sections = (briefing.sections ?? []).map((section, order) => ({ ...section, order, maxItems: Math.max(1, Math.floor(section.maxItems || 1)) }));
	const set = sections.filter(({ budgetShare }) => Number.isFinite(budgetShare));
	const left = Math.max(0, 100 - set.reduce((total, { budgetShare }) => total + budgetShare, 0));
	const unset = sections.length - set.length;
	return sections.map((section) => ({ ...section, budgetShare: Number.isFinite(section.budgetShare) ? section.budgetShare : unset ? left / unset : 0 }));
}

export function byPriority(sections) {
	return [...sections].sort((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity) || a.order - b.order);
}

// The lead: the first section by priority written as sentences. It takes the best story overall.
export function leadOf(sections) {
	return byPriority(sections).find(({ format }) => format === "sentences") ?? null;
}

// Each section's cap in USD: its share of the extract and write steps' shares of the budget.
export function sectionCaps(sections, meter) {
	const pool = meter.shareOf("extract") + meter.shareOf("write");
	return Object.fromEntries(sections.map(({ id, budgetShare }) => [id, (pool * budgetShare) / 100]));
}

// A shortlist wide enough to fill every section's cap, within the funnel's maximum.
export function sectionedShortlist(briefing, shortlist) {
	const caps = sectionsOf(briefing).reduce((total, { maxItems }) => total + maxItems, 0);
	return Math.min(DISCOVERY_MAXIMUMS.shortlist, Math.max(shortlist, Math.ceil(caps * 1.25)));
}

// { storyId: sectionId | "none" }: one Jev request with a Choice question per story, or one JSON call to the triage model.
export async function assignStories(ctx, stories, sections) {
	const { briefing } = ctx;
	const step = await ctx.keyFor("triage");
	const valid = new Set(sections.map(({ id }) => id));
	const pick = (value) => (valid.has(value) ? value : NO_SECTION);
	if (step.key.provider === "typesafe") {
		const { state, questions } = assignTypeSafe({ briefing, stories, sections });
		const { answers } = await ctx.models.typesafe({ key: step.key, model: step.model, step: "triage", state, questions });
		return Object.fromEntries(stories.map((story) => [story.id, pick(answers?.[`${story.id}_section`]?.choice)]));
	}
	const { system, user, maxTokens } = assignPrompt({ briefing, stories, sections });
	const { json } = await ctx.models.text({ key: step.key, model: step.model, step: "triage", system, user, json: true, maxTokens, temperature: 0 });
	return Object.fromEntries(stories.map((story) => [story.id, pick(json?.sections?.[story.id])]));
}

// Sections filled in priority order up to their caps by score, one section a story. The lead takes the best story overall; the
// others take the stories assigned to them over their format's bar (minScore for sentences, three quarters of it for one-liners).
export function fillSections({ scored, assignment, sections, minScore }) {
	const used = new Set();
	const filled = Object.fromEntries(sections.map(({ id }) => [id, []]));
	const lead = leadOf(sections);
	if (lead && scored[0] && scored[0].score >= minScore) {
		filled[lead.id].push(scored[0]);
		used.add(scored[0].key);
	}
	for (const section of byPriority(sections)) {
		const bar = section.format === "sentences" ? minScore : minScore * 0.75;
		for (const story of scored) {
			if (filled[section.id].length >= section.maxItems) break;
			if (used.has(story.key) || assignment[story.id] !== section.id || story.score < bar) continue;
			filled[section.id].push(story);
			used.add(story.key);
		}
	}
	return filled;
}

// After triage's scores and the merge: assignment, then the picks. Answers the triage stage's result.
export async function pickSectioned(ctx, scored, describeStory) {
	const { run, briefing, work } = ctx;
	const sections = sectionsOf(briefing);
	let assignment = {};
	try {
		assignment = await assignStories(ctx, scored, sections);
	} catch (error) {
		if (isAuthFailure(error) || !(error instanceof BudgetStop || error instanceof ProviderError)) throw error;
		work.partial = true;
		run.discoveryNotes.push({ provider: "sections", problem: `Stories couldn't be sorted into sections, so only the lead was filled: ${ctx.describe(error)}`, scope: error instanceof BudgetStop ? "budget" : "error" });
	}
	const filled = fillSections({ scored, assignment, sections, minScore: work.minScore });
	const picked = [];
	for (const section of sections) {
		for (const story of filled[section.id]) picked.push({ ...story, sectionId: section.id, kind: section.format === "sentences" ? "full" : "brief" });
	}
	work.picked = picked;
	work.brief = [];
	work.sectionPlan = sections.map(({ id, title, format, maxItems, budgetShare, priority, order }) => ({ id, title, format, maxItems, budgetShare, priority, order }));
	run.sections = sections.map(({ id, title }) => ({ id, title, status: "empty", items: filled[id].length, costUsd: 0 }));
	run.counts.picked = picked.length;
	run.stories = picked.map((story) => describeStory(story, briefing));
	return picked.length ? { next: "extract" } : { finish: "no_news" };
}

function rateLimitWait(ctx, error, key) {
	ctx.work.rateLimited ??= {};
	ctx.work.rateLimited[key] = (ctx.work.rateLimited[key] ?? 0) + 1;
	if (ctx.work.rateLimited[key] > RATE_LIMIT_ATTEMPTS) return null;
	return Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : 60_000;
}

// A 429 (Groq's per-minute token limit) is waited out within the tick, or the run is saved and goes on at the next tick; only
// after RATE_LIMIT_ATTEMPTS is the item given up.
const RATE_LIMIT_ATTEMPTS = 6;

async function waitOrYield(ctx, error, key) {
	const wait = rateLimitWait(ctx, error, key);
	if (wait === null) return null;
	if (ctx.canWait(wait)) {
		await ctx.sleep(wait);
		return { partial: true };
	}
	return { yield: true };
}

function priorityOf(work) {
	return new Map(byPriority(work.sectionPlan).map(({ id }, index) => [id, index]));
}

// One item per pass, the sections in priority order. A section past its share does less; past the run's budget, every item left
// is skipped and its section marked skipped_budget when it is left with nothing.
export async function extractSectioned(ctx, helpers) {
	const { run, briefing, work } = ctx;
	work.records ??= [];
	work.dropped ??= [];
	work.done ??= [];
	work.extractFailed ??= [];
	work.skippedForBudget ??= {};
	const rank = priorityOf(work);
	const queue = [...work.picked].sort((a, b) => rank.get(a.sectionId) - rank.get(b.sectionId) || b.score - a.score);
	const story = queue.find(({ key }) => !work.done.includes(key));
	if (!story) {
		run.stories = work.picked.filter(({ key }) => work.records.some((record) => record.storyKey === key)).map((each) => helpers.describeStory(each, briefing));
		if (work.records.length) return { next: "write" };
		if (Object.keys(work.skippedForBudget).length) throw new BudgetStop("Stopped at the extract step: not one section's story fitted the budget.", { step: "extract", scope: "run" });
		return { finish: "no_news" };
	}
	if (work.extractOutOfMoney) {
		work.skippedForBudget[story.sectionId] = (work.skippedForBudget[story.sectionId] ?? 0) + 1;
		work.done.push(story.key);
		return { partial: true };
	}
	const section = work.sectionPlan.find(({ id }) => id === story.sectionId);
	const { key, model } = await ctx.keyFor("extract");
	const extract = section.format === "one-liners" ? extractOneLiner : extractStory;
	try {
		const result = await extract({ briefing, story, n: (work.nextN = (work.nextN ?? 0) + 1), since: work.since, fetcher: ctx.fetcher, providerFetch: helpers.providerFetch, key, model, models: ctx.models, resolved: (work.resolved ??= {}), sectionId: section.id });
		if (result.stale) {
			(work.stale ??= []).push(result.stale);
			work.dropped.push({ storyKey: story.key, title: story.title, problems: ["older than the previous run"], stale: true });
		} else if (result.record) {
			work.records.push({ ...result.record, sectionId: section.id });
			story.url = result.record.url;
			story.sourceKind = result.record.sourceKind;
			if (result.previewImage) story.previewImage = result.previewImage;
		} else work.dropped.push(result.dropped);
	} catch (error) {
		if (error instanceof ProviderError && error.status === 429) {
			const next = await waitOrYield(ctx, error, `extract:${story.key}`);
			if (next) return next;
		}
		if (error instanceof BudgetStop) {
			work.skippedForBudget[section.id] = (work.skippedForBudget[section.id] ?? 0) + 1;
			work.partial = true;
			if (error.scope !== "section") {
				work.extractOutOfMoney = true;
				run.discoveryNotes.push({ provider: "extract", problem: "The budget ran out during extract: the remaining sections' stories were left out", scope: "budget" });
			}
		} else if (error instanceof ProviderError && !isAuthFailure(error)) {
			work.extractFailed.push({ storyKey: story.key, title: story.title, problem: ctx.describe(error) });
		} else throw error;
	}
	work.done.push(story.key);
	return { partial: true };
}

// A section's Markdown held to its format: no headings of the issue's level, and for one-liners only cited bullets, each with its
// main entity in bold.
export function shapeSection(markdown, section, records) {
	const text = String(markdown ?? "")
		.trim()
		.replace(/^#{1,6}\s+[^\n]*\n*/, "")
		.replace(/^#{1,2}(\s)/gm, "###$1")
		.trim();
	if (section.format !== "one-liners") return text;
	const byNumber = new Map(records.map((record) => [record.n, record]));
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => /^[-*] /.test(line) && citesOf(line).some((n) => byNumber.has(n)))
		.map((line) => {
			const body = line.replace(/^[-*] /, "");
			if (/^\*\*[^*]+\*\*/.test(body)) return `- ${body}`;
			const entity = byNumber.get(citesOf(line)[0])?.entities?.[0];
			return entity ? `- **${entity}** ${body}` : `- ${body}`;
		})
		.join("\n");
}

// The issue: the written sections in reading order under their titles.
export function renderSections(plan, drafts) {
	return [...plan]
		.sort((a, b) => a.order - b.order)
		.filter(({ id }) => drafts[id]?.markdown)
		.map(({ id, title }) => `## ${title}\n\n${drafts[id].markdown}`)
		.join("\n\n");
}

function setSection(run, id, fields) {
	const entry = run.sections.find((section) => section.id === id);
	if (entry) Object.assign(entry, fields);
}

// One section per pass, in priority order. A section the budget can't pay for is skipped_budget; past the run's budget, so are
// all after it. A section with no records is empty and left out of the issue.
export async function writeSectioned(ctx) {
	const { run, briefing, work } = ctx;
	work.sectionDrafts ??= {};
	const lead = leadOf(work.sectionPlan);
	const next = byPriority(work.sectionPlan).find(({ id }) => !work.sectionDrafts[id]);
	if (next) {
		const records = work.records.filter(({ sectionId }) => sectionId === next.id);
		if (!records.length) {
			work.sectionDrafts[next.id] = { status: work.skippedForBudget?.[next.id] ? "skipped_budget" : "empty" };
		} else if (work.writeOutOfMoney) {
			work.sectionDrafts[next.id] = { status: "skipped_budget" };
		} else {
			const isLead = next.id === lead?.id;
			const others = isLead ? work.records.filter(({ sectionId }) => sectionId !== next.id).slice(0, 3).map(({ n, title }) => ({ n, title })) : [];
			const { system, user, maxTokens } = sectionWritePrompt({ briefing, section: next, records, next: others, lead: isLead, language: languageName(briefing.languages?.[0] ?? "en") });
			try {
				const { key, model } = await ctx.keyFor("write");
				const { text } = await ctx.models.text({ key, model, step: "write", sectionId: next.id, system, user, maxTokens, temperature: 0.4 });
				const parsed = isLead ? parseDraft(text) : { markdown: sanitizeModelMarkdown(text) };
				const markdown = shapeSection(parsed.markdown, next, [...records, ...work.records.filter(({ n }) => others.some((other) => other.n === n))]);
				work.sectionDrafts[next.id] = markdown ? { status: "written", markdown } : { status: "empty" };
				if (isLead) work.leadDraft = { subject: parsed.subject, previewText: parsed.previewText };
			} catch (error) {
				if (error instanceof ProviderError && error.status === 429) {
					const wait = await waitOrYield(ctx, error, `write:${next.id}`);
					if (wait) return wait;
				}
				if (error instanceof BudgetStop) {
					work.partial = true;
					work.sectionDrafts[next.id] = { status: "skipped_budget", problem: error.message.slice(0, 160) };
					if (error.scope !== "section") work.writeOutOfMoney = true;
				} else if (error instanceof ProviderError && !isAuthFailure(error)) {
					work.partial = true;
					work.sectionDrafts[next.id] = { status: "failed", problem: ctx.describe(error).slice(0, 160) };
				} else throw error;
			}
		}
		const draft = work.sectionDrafts[next.id];
		setSection(run, next.id, { status: draft.status, items: draft.status === "written" ? records.length : 0, ...(draft.problem && { problem: draft.problem }) });
		return { partial: true };
	}
	const body = renderSections(work.sectionPlan, work.sectionDrafts);
	if (!body) {
		if (Object.values(work.sectionDrafts).some(({ status }) => status === "skipped_budget")) throw new BudgetStop("Stopped at the write step: not one section fitted the budget.", { step: "write", scope: "run" });
		throw new Error("No section could be written");
	}
	const written = new Set(Object.entries(work.sectionDrafts).filter(([, { status }]) => status === "written").map(([id]) => id));
	work.records = work.records.filter(({ sectionId }) => written.has(sectionId));
	const first = work.records[0];
	work.draft = { subject: work.leadDraft?.subject || first?.title?.slice(0, 120) || briefing.name, previewText: work.leadDraft?.previewText ?? "", markdown: labelOrigins(body, work.records) };
	return { next: "check" };
}

// The checks, section by section, each recorded as "<section id>/<check id>"; the links of the whole issue first, resumable.
export async function checkSectioned(ctx, leftOutChecks) {
	const { run, briefing, work } = ctx;
	const { draft, records } = work;
	const linkedMarkdown = linkCitations(draft.markdown, records);
	work.linkStates ??= {};
	const resolved = work.resolved ?? {};
	const toCheck = renderedLinks(linkedMarkdown).filter((url) => resolved[url] !== "ok" && !/robots\.txt/.test(resolved[url] ?? ""));
	if (!(await checkLinks({ links: toCheck, fetcher: ctx.fetcher, states: work.linkStates, hasTime: ctx.hasTime })).done) return { partial: true };
	const checks = [];
	const step = await ctx.keyFor("check");
	const sameModel = step.model === briefing.steps?.write?.model && String(briefing.steps?.check?.keyId) === String(briefing.steps?.write?.keyId);
	const lead = leadOf(work.sectionPlan);
	for (const section of [...work.sectionPlan].sort((a, b) => a.order - b.order)) {
		if (work.sectionDrafts[section.id]?.status !== "written") continue;
		const own = records.filter(({ sectionId }) => sectionId === section.id);
		const cited = new Set(citesOf(work.sectionDrafts[section.id].markdown));
		const grounds = records.filter(({ n, sectionId }) => sectionId === section.id || cited.has(n));
		const markdown = `## ${section.title}\n\n${work.sectionDrafts[section.id].markdown}`;
		const sectionDraft = { markdown, subject: section.id === lead?.id ? draft.subject : "", previewText: section.id === lead?.id ? draft.previewText : "" };
		const found = await codeChecks({ draft: sectionDraft, linkedMarkdown: linkCitations(markdown, grounds), records: grounds, fetcher: ctx.fetcher, resolved, linkStates: work.linkStates });
		const kept = found.filter(({ id }) => id !== "length" && (id !== "originals" || own.length));
		if (!sameModel) kept.push(...(await claimChecks({ draft: sectionDraft, records: grounds, key: step.key, model: step.model, models: ctx.models, sectionId: section.id, batched: true })));
		checks.push(...kept.map((check) => ({ ...check, id: `${section.id}/${check.id}` })));
	}
	if (sameModel) checks.push({ id: "check_model", status: "warning", message: "The check step uses the writer's own model, so the claim check was skipped" });
	checks.push(...leftOutChecks(work));
	run.checks = checks;
	work.linkedMarkdown = linkedMarkdown;
	work.checked = true;
	work.translations = [];
	run.languages = (briefing.languages ?? []).slice(1).map((language) => ({ language, status: "pending" }));
	return run.languages.length ? { partial: true } : { next: "deliver" };
}

// Each section's model spend: its extract, write and check calls.
export function sectionCosts(run) {
	for (const section of run.sections ?? []) {
		section.costUsd = Math.round(run.calls.filter(({ sectionId }) => sectionId === section.id).reduce((total, { costUsd }) => total + (costUsd || 0), 0) * 1e8) / 1e8;
	}
}
