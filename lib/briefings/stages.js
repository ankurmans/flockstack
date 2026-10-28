import { returnAiRequest, takeAiRequest } from "../ai-usage.js";
import { DEFAULT_MIN_SCORE, DEFAULT_STORIES, MAX_BRIEF_ITEMS, MAX_FULL_STORIES } from "../briefing-rules.js";
import { checkLinks, claimChecks, codeChecks, renderedLinks } from "./check.js";
import { dedupeItems, toItem } from "./dedupe.js";
import { discoverySettings, lookbackStart, providerFetcher, runDiscovery } from "./discovery/index.js";
import { briefRecord, extractStory } from "./extract.js";
import { clusterItems, embedTexts, embeddingText } from "./group.js";
import { BudgetStop } from "./meter.js";
import { SIMILAR, mergeDuplicates } from "./merge.js";
import { ProviderError, isAuthFailure } from "./providers.js";
import { baseFeatures, cosine, rankModel, scoreFeatures, titleWords } from "./rank.js";
import { JEV_FEATURES, pickStories, scoreStories, triageInput, triageMaxTokens } from "./triage.js";
import { hostOf } from "./urls.js";
import { readablePage } from "./readable.js";
import { checkSectioned, extractSectioned, isSectioned, pickSectioned, sectionCosts, sectionedShortlist, sectionsOf, writeSectioned } from "./sections.js";
import { linkCitations, sectionFor, translateDraft, writeDraft } from "./write.js";

// The stages of a run (docs/BRIEFINGS-DESIGN.md, The run). Each reads the run's working data and answers { next }, { partial }
// (saved; more of the same stage to do), { yield } (saved; wait for the next tick) or { finish: status }.
const RECENT_MS = 7 * 24 * 60 * 60_000;
const TRANSLATION_ATTEMPTS = 2;

// Why a language wasn't translated, in a short line for run.languages[].problem.
function translationProblem(error, ctx) {
	if (error instanceof BudgetStop && Number.isFinite(error.estimate)) {
		return `Needs about $${error.estimate.toFixed(4)}; $${(error.left ?? 0).toFixed(4)} of the translate step's $${(error.share ?? 0).toFixed(4)} share was left`;
	}
	return ctx.describe(error).slice(0, 160);
}

export function storySettings(briefing) {
	const own = briefing.stories ?? {};
	const read = (name, top) => (Number.isFinite(own[name]) && own[name] >= 0 ? Math.min(own[name], top) : DEFAULT_STORIES[name]);
	const maxFull = Math.max(1, read("maxFull", MAX_FULL_STORIES));
	return { minFull: Math.min(read("minFull", MAX_FULL_STORIES), maxFull), maxFull, briefItems: read("briefItems", MAX_BRIEF_ITEMS) };
}

function describeStory(story, briefing) {
	return {
		storyKey: story.key,
		externalId: `briefing:${briefing._id}:${story.key}`,
		kind: story.kind,
		title: story.title,
		url: story.url,
		sourceKind: story.sourceKind ?? "other",
		score: story.score,
		foundBy: story.foundBy,
		sources: [...new Set(story.sources.map(({ publisher }) => publisher))],
		features: story.features,
		...(story.sectionId && { sectionId: story.sectionId }),
		...(story.previewImage && { previewImage: story.previewImage }),
	};
}

// The features the owner's verdicts were saved with, and the texts similarity is measured against.
async function reference(ctx, vectorsFor) {
	const history = await ctx.history();
	const examples = (ctx.briefing.brief?.examples ?? []).map(({ url, note }) => ({ text: `${note ?? ""} ${String(url).replace(/[^\p{L}\p{N}]+/gu, " ")}`.trim() }));
	const kept = history.filter(({ verdict, title }) => verdict === "keep" && title).slice(0, 50).map(({ title }) => ({ text: title }));
	const dropped = history.filter(({ verdict, title }) => verdict === "drop" && title).slice(0, 50).map(({ title }) => ({ text: title }));
	const all = [...examples, ...kept, ...dropped];
	const vectors = await vectorsFor(all.map(({ text }) => text));
	all.forEach((entry, index) => {
		entry.vector = vectors?.[index] ?? null;
		entry.words = titleWords(entry.text);
	});
	return { examples, kept, dropped, history };
}

export const STAGES = {
	async discover(ctx) {
		const { run, briefing, work } = ctx;
		if (ctx.discover) {
			// A discovery handed in by the caller (tests, or a later design): its items as they come, deduped here.
			const found = await ctx.discover({ briefing, run: { _id: run._id, slot: run.slot, isManual: run.isManual, startedAt: run.startedAt }, env: ctx.env, fetchImpl: ctx.fetchImpl, now: ctx.now });
			for (const problem of (found?.errors ?? []).slice(0, 50)) {
				run.discoveryNotes.push(typeof problem === "string" ? { provider: "discover", problem: problem.slice(0, 300), scope: "error" } : { provider: String(problem?.provider ?? problem?.foundBy ?? "discover"), problem: String(problem?.problem ?? problem?.message ?? "").slice(0, 300), scope: String(problem?.scope ?? "error") });
			}
			const items = (await Promise.all((Array.isArray(found?.items) ? found.items : []).map(toItem))).filter((item) => item && !ctx.fetcher.isBlocked(item.url)).map((item) => ({ ...item, foundBy: [item.foundBy || "discover"] }));
			const since = lookbackStart(briefing, run.startedAt ?? ctx.now);
			work.since = since.toISOString();
			work.fresh = (await dedupeItems({ items, seen: ctx.seen, since })).slice(0, discoverySettings(briefing).maxCandidates);
			run.counts.results = items.length;
			run.counts.candidates = items.length;
			run.counts.fresh = work.fresh.length;
		} else {
			const pass = await runDiscovery(ctx);
			if (!pass.done) return pass;
		}
		const { minFull } = storySettings(briefing);
		run.thin = work.fresh.length < 2 * Math.max(1, minFull);
		return work.fresh.length ? { next: "group" } : { finish: "no_news" };
	},

	// Cluster, then rank on what is known without a model, and keep the shortlist.
	async group(ctx) {
		const { run, briefing, work, account } = ctx;
		let allowed = typeof ctx.ai?.run === "function" ? null : false;
		const vectorsFor = async (texts) => {
			if (allowed === false || !texts.length) return null;
			if (allowed === null) allowed = (await takeAiRequest(account, ctx.now)).allowed;
			if (!allowed) return null;
			try {
				return await embedTexts(ctx.ai, texts);
			} catch {
				if (allowed === true) await returnAiRequest(account, ctx.now);
				allowed = false;
				return null;
			}
		};
		const vectors = work.fresh.length > 1 ? await vectorsFor(work.fresh.map(embeddingText)) : null;
		const stories = clusterItems(work.fresh, vectors, { trustedOutlets: briefing.trustedOutlets ?? [] });
		work.grouping = vectors ? "embeddings" : "words";
		const ref = await reference(ctx, vectorsFor);
		const model = rankModel(ref.history);
		const publishers = await ctx.publishers([...new Set(stories.flatMap(({ sources }) => sources.map(({ host }) => host)))]);
		const vectorOf = (story) => vectors?.[story.vectorIndex] ?? null;
		for (const story of stories) {
			story.features = { ...Object.fromEntries(JEV_FEATURES.map((name) => [name, null])), ...baseFeatures({ story, reference: { ...ref, vectorOf }, publishers, trustedOutlets: briefing.trustedOutlets, now: ctx.now }) };
			story.score = scoreFeatures(story.features, model);
		}
		const shortlist = isSectioned(briefing) ? sectionedShortlist(briefing, discoverySettings(briefing).shortlist) : discoverySettings(briefing).shortlist;
		work.shortlist = stories.sort((a, b) => b.score - a.score).slice(0, Math.max(1, shortlist));
		// Pairs close enough to be one event told twice, for the merge after triage (lib/briefings/merge.js).
		work.similar = {};
		if (vectors) {
			for (const [index, story] of work.shortlist.entries()) {
				for (const other of work.shortlist.slice(index + 1)) {
					if (cosine(vectors[story.vectorIndex], vectors[other.vectorIndex]) > SIMILAR) (work.similar[story.key] ??= []).push(other.key);
				}
			}
		}
		for (const story of stories) delete story.vectorIndex;
		work.rankModel = { kind: model.kind, verdicts: model.verdicts, weights: model.weights, bias: model.bias };
		work.recent = ref.history.filter(({ verdict, title, decidedAt }) => verdict === "keep" && title && ctx.now - new Date(decidedAt) < RECENT_MS).slice(0, 30);
		work.shortlistHosts = [...new Set(work.shortlist.flatMap(({ sources }) => sources.map(({ host }) => host)))];
		run.counts.groups = stories.length;
		run.counts.shortlisted = work.shortlist.length;
		delete work.fresh;
		work.seenHashes = [...new Set(stories.flatMap(({ sources }) => sources.map(({ urlHash }) => urlHash)))];
		work.seenHosts = Object.fromEntries(stories.flatMap(({ sources }) => sources.map(({ host }) => host)).reduce((counts, host) => counts.set(host, (counts.get(host) ?? 0) + 1), new Map()));
		return { next: "triage" };
	},

	// Jev's four scores (or the triage model's) for as much of the shortlist as the step's share pays for, then the final score
	// and the picks: full stories and brief items.
	async triage(ctx) {
		const { run, briefing, work } = ctx;
		let list = work.shortlist;
		const step = briefing.steps?.triage?.keyId ? await ctx.keyFor("triage") : null;
		if (step) {
			while (list.length) {
				try {
					ctx.meter.admit({ step: "triage", provider: step.key.provider, model: step.model, input: triageInput({ briefing, stories: list, recent: work.recent, key: step.key }), maxTokens: triageMaxTokens({ briefing, stories: list, recent: work.recent, key: step.key }) });
					break;
				} catch (error) {
					if (!(error instanceof BudgetStop)) throw error;
					list = list.slice(0, Math.floor(list.length * 0.75));
				}
			}
			if (list.length < work.shortlist.length) {
				work.partial = true;
				run.discoveryNotes.push({ provider: "triage", problem: `Only ${list.length} of ${work.shortlist.length} shortlisted stories fit the triage step's share of the budget`, scope: "budget" });
			}
			if (list.length) {
				const scores = await scoreStories({ briefing, stories: list, recent: work.recent, key: step.key, model: step.model, models: ctx.models });
				for (const story of list) Object.assign(story.features, scores[story.id]);
			}
		} else {
			work.partial = true;
			run.discoveryNotes.push({ provider: "triage", problem: "The briefing has no triage key, so stories were ranked without Jev's scores", scope: "error" });
		}
		const model = { ...work.rankModel };
		for (const story of work.shortlist) story.score = scoreFeatures(story.features, model);
		const settings = storySettings(briefing);
		const sectioned = isSectioned(briefing);
		const window = sectioned ? 2 * sectionsOf(briefing).reduce((total, { maxItems }) => total + maxItems, 0) : 2 * (settings.maxFull + settings.briefItems);
		const scored = mergeDuplicates([...work.shortlist].sort((a, b) => b.score - a.score), { similar: work.similar, trustedOutlets: briefing.trustedOutlets ?? [], window });
		if (sectioned) {
			work.minScore = briefing.minScore ?? DEFAULT_MIN_SCORE;
			const result = await pickSectioned(ctx, scored, describeStory);
			work.storyOf = Object.fromEntries(work.picked.flatMap((story) => story.sources.map(({ urlHash }) => [urlHash, story.key])));
			work.pickedHosts = [...new Set(work.picked.map(({ url }) => hostOf(url)))];
			delete work.shortlist;
			return result;
		}
		const { full, brief } = pickStories(scored, { minScore: briefing.minScore ?? DEFAULT_MIN_SCORE, ...settings });
		work.picked = full;
		work.brief = brief;
		work.storyOf = Object.fromEntries([...full, ...brief].flatMap((story) => story.sources.map(({ urlHash }) => [urlHash, story.key])));
		work.pickedHosts = [...new Set(full.map(({ url }) => hostOf(url)))];
		run.counts.picked = full.length + brief.length;
		run.stories = [...full, ...brief].map((story) => describeStory(story, briefing));
		delete work.shortlist;
		return full.length ? { next: "extract" } : { finish: "no_news" };
	},

	// One full story per pass. Past the step's share, the rest become brief items; a story whose sources can't be read is dropped.
	async extract(ctx) {
		const { run, briefing, work } = ctx;
		if (isSectioned(briefing)) return extractSectioned(ctx, { describeStory, providerFetch: providerFetcher(ctx) });
		work.records ??= [];
		work.dropped ??= [];
		work.done ??= [];
		work.extractFailed ??= [];
		const story = work.picked.find(({ key }) => !work.done.includes(key));
		if (!story && !work.briefDated) {
			// A brief item with no date from discovery is dated by its own page, so weeks-old news doesn't pass for today's.
			const undated = (work.brief ?? []).filter((each) => !each.publishedAt && !each.dated);
			for (const each of undated) {
				if (!ctx.hasTime()) return { partial: true };
				each.dated = true;
				try {
					const fetched = await ctx.fetcher.get(each.url);
					(work.resolved ??= {})[each.url] = "ok";
					const page = readablePage(fetched.text, fetched.url);
					each.publishedAt = page.publishedAt;
					if (page.image) each.previewImage = page.image;
				} catch {
					// The link check judges a page that won't open.
				}
			}
			const cutoff = work.since ? new Date(work.since).getTime() : -Infinity;
			const stale = work.brief.filter((each) => each.publishedAt && new Date(each.publishedAt).getTime() < cutoff);
			if (stale.length) {
				(work.stale ??= []).push(...stale.map(({ key, title, publishedAt }) => ({ storyKey: key, title, publishedAt })));
				work.brief = work.brief.filter((each) => !stale.includes(each));
			}
			work.briefDated = true;
		}
		if (!story) {
			// Only a run where no story could be extracted, every one for an error, fails: one bad answer costs a story, not the issue.
			if (!work.records.length && !work.extractShort && work.extractFailed.length && work.extractFailed.length === work.picked.length) {
				throw new Error(`Every story's extract failed: ${work.extractFailed.at(-1).problem}`);
			}
			const kept = new Set(work.records.map(({ storyKey }) => storyKey));
			const demoted = work.picked.filter(({ key }) => !kept.has(key) && !work.dropped.some((drop) => drop.storyKey === key));
			work.brief = [...demoted.map((each) => ({ ...each, kind: "brief" })), ...work.brief].slice(0, Math.max(storySettings(briefing).briefItems, demoted.length));
			work.picked = work.picked.filter(({ key }) => kept.has(key));
			run.stories = [...work.picked, ...work.brief].map((each) => describeStory(each, briefing));
			if (!work.records.length && work.extractShort) throw new BudgetStop("Stopped at the extract step: not one story fitted its share of the budget.", { step: "extract", scope: "step" });
			return work.records.length ? { next: "write" } : { finish: "no_news" };
		}
		if (work.extractShort) {
			work.done.push(story.key);
			return { partial: true };
		}
		const { key, model } = await ctx.keyFor("extract");
		try {
			const result = await extractStory({ briefing, story, n: work.records.length + 1, since: work.since, fetcher: ctx.fetcher, providerFetch: providerFetcher(ctx), key, model, models: ctx.models, resolved: (work.resolved ??= {}) });
			if (result.stale) {
				(work.stale ??= []).push(result.stale);
				work.dropped.push({ storyKey: story.key, title: story.title, problems: ["older than the previous run"], stale: true });
			} else if (result.record) {
				work.records.push(result.record);
				const sourceKind = result.record.sourceKind;
				story.sourceKind = story.url === result.record.url || !story.sourceKind ? sourceKind : story.sourceKind;
				story.url = result.record.url;
				if (result.previewImage) story.previewImage = result.previewImage;
			} else work.dropped.push(result.dropped);
		} catch (error) {
			if (error instanceof ProviderError && !isAuthFailure(error)) {
				// The story stays as a brief item when it has a title and a public https link to give, else it is left out.
				work.extractFailed.push({ storyKey: story.key, title: story.title, problem: ctx.describe(error) });
				if (!(story.title && /^https:\/\//.test(story.url ?? ""))) work.dropped.push({ storyKey: story.key, title: story.title, problems: [ctx.describe(error)] });
				work.done.push(story.key);
				return { partial: true };
			}
			if (!(error instanceof BudgetStop)) throw error;
			work.extractShort = true;
			work.partial = true;
			run.discoveryNotes.push({ provider: "extract", problem: "The extract step's share of the budget ran out: the remaining stories are brief items", scope: "budget" });
		}
		work.done.push(story.key);
		return { partial: true };
	},

	async write(ctx) {
		const { work, briefing } = ctx;
		if (isSectioned(briefing)) return writeSectioned(ctx);
		const full = work.records.map((record, index) => ({ ...record, n: index + 1 }));
		const brief = work.brief.map((story, index) => briefRecord(story, full.length + index + 1));
		work.records = [...full, ...brief];
		const { key, model } = await ctx.keyFor("write");
		work.draft = await writeDraft({ briefing, records: work.records, key, model, models: ctx.models });
		return { next: "check" };
	},

	// The checks, then one translation per extra language, each within the translate step's share.
	async check(ctx) {
		const { run, briefing, work } = ctx;
		const { draft, records } = work;
		if (!work.checked && isSectioned(briefing)) return checkSectioned(ctx, leftOutChecks);
		if (!work.checked) {
			const linkedMarkdown = linkCitations(draft.markdown, records);
			// The links first, a few at a time and resumable, so a draft with many slow links can't outlast the Worker.
			work.linkStates ??= {};
			const resolved = work.resolved ?? {};
			const toCheck = renderedLinks(linkedMarkdown).filter((url) => resolved[url] !== "ok" && !/robots\.txt/.test(resolved[url] ?? ""));
			if (!(await checkLinks({ links: toCheck, fetcher: ctx.fetcher, states: work.linkStates, hasTime: ctx.hasTime })).done) return { partial: true };
			const checks = await codeChecks({ draft, linkedMarkdown, records, fetcher: ctx.fetcher, resolved, linkStates: work.linkStates });
			checks.push(...leftOutChecks(work));
			const step = await ctx.keyFor("check");
			if (step.model === briefing.steps?.write?.model && String(briefing.steps?.check?.keyId) === String(briefing.steps?.write?.keyId)) {
				checks.push({ id: "check_model", status: "warning", message: "The check step uses the writer's own model, so the claim check was skipped" });
			} else {
				checks.push(...(await claimChecks({ draft, records, key: step.key, model: step.model, models: ctx.models })));
			}
			run.checks = checks;
			work.linkedMarkdown = linkedMarkdown;
			work.checked = true;
			work.translations = [];
			run.languages = (briefing.languages ?? []).slice(1).map((language) => ({ language, status: "pending" }));
			return run.languages.length ? { partial: true } : { next: "deliver" };
		}
		return translateNext(ctx);
	},

	async deliver(ctx) {
		const { run, briefing, work } = ctx;
		if (typeof ctx.delivery?.deliverIssue !== "function") throw new Error("No delivery is set up for briefings on this server");
		sectionCosts(run);
		run.heldReason = holdReason({ run, work, briefing }) ?? undefined;
		const stories = work.records.map((record) => ({
			storyKey: record.storyKey,
			...(record.sectionId && { sectionId: record.sectionId }),
			externalId: `briefing:${briefing._id}:${record.urlHash}`,
			kind: record.kind,
			sourceKind: record.sourceKind,
			title: record.title,
			hook: firstSentence(record.what) || record.title,
			body: linkCitations(sectionFor(work.draft.markdown, record), work.records) || record.what,
			url: record.url,
			references: [
				{ label: record.label || hostOf(record.url), url: record.url, kind: "original" },
				...(record.primaryUrl ? [{ label: hostOf(record.primaryUrl), url: record.primaryUrl, kind: "primary" }] : []),
				...(record.coverage ?? []).map(({ url }) => ({ label: hostOf(url), url, kind: "coverage" })),
			],
		}));
		const result = await ctx.delivery.deliverIssue({
			accountId: String(run.accountId),
			newsletterId: String(run.newsletterId),
			briefingId: String(briefing._id),
			runId: String(run._id),
			slot: run.slot,
			subject: work.draft.subject,
			previewText: work.draft.previewText,
			markdown: work.linkedMarkdown,
			stories,
			translations: (work.translations ?? []).map(({ language, subject, previewText, markdown }) => ({ language, subject, previewText, markdown, beta: true })),
			testEmail: briefing.testEmail ?? null,
			checks: run.checks,
			costUsd: ctx.meter.spent(),
			thin: Boolean(run.thin),
			heldReason: run.heldReason ?? null,
			reviewMode: briefing.reviewMode ?? "draft",
			discoveryNotes: run.discoveryNotes.map(({ provider, problem, scope, until }) => ({ provider, problem, scope, until: until ? new Date(until).toISOString() : null })),
			sections: (run.sections ?? []).map(({ id, title, status, items, costUsd }) => ({ id, title, status, items, costUsd })),
		});
		return { finish: result?.status === "sent" && !run.heldReason ? "sent" : "drafted", campaignId: result?.campaignId };
	},
};


// The stories a run left out, and why, as checks.
export function leftOutChecks(work) {
	const checks = [];
	if (work.extractFailed?.length) checks.push({ id: "extract_failed", status: "warning", message: `Couldn't be extracted, so they are brief items or left out: ${work.extractFailed.map(({ title }) => `"${title}"`).join(", ")}` });
	if (work.stale?.length) checks.push({ id: "stale", status: "warning", message: `Left out as older than the previous run, by their own pages: ${work.stale.map(({ title }) => `"${title}"`).join(", ")}` });
	const dropped = (work.dropped ?? []).filter(({ stale }) => !stale);
	if (dropped.length) checks.push({ id: "dropped", status: "warning", message: `Left out, as no public page of theirs could be read: ${dropped.map(({ title }) => `"${title}"`).join(", ")}` });
	return checks;
}

// One language a pass, after the checks. One the provider turned away for its rate limit waits out its Retry-After when the
// tick has the time, goes to the back and is tried once more after the others.
export async function translateNext(ctx) {
	const { run, briefing, work } = ctx;
	const { draft, records } = work;
	work.translationAttempts ??= {};
	const pending = run.languages.filter(({ status }) => status === "pending");
	const entry = pending.sort((a, b) => (work.translationAttempts[a.language] ?? 0) - (work.translationAttempts[b.language] ?? 0))[0];
	if (!entry) return { next: "deliver" };
	work.translationAttempts[entry.language] = (work.translationAttempts[entry.language] ?? 0) + 1;
	if (!briefing.steps?.translate?.keyId) entry.status = "skipped_no_key";
	else {
		try {
			const { key, model } = await ctx.keyFor("translate");
			work.translations.push(await translateDraft({ draft, records, language: entry.language, key, model, models: ctx.models }));
			entry.status = "done";
			delete entry.problem;
		} catch (error) {
			// A translation is beta: whatever goes wrong with one, the draft in the first language still goes out.
			const rateLimited = error instanceof ProviderError && error.status === 429;
			if (rateLimited && work.translationAttempts[entry.language] < TRANSLATION_ATTEMPTS) {
				entry.problem = translationProblem(error, ctx);
				if (Number.isFinite(error.retryAfterMs) && ctx.canWait(error.retryAfterMs)) await ctx.sleep(error.retryAfterMs);
				return { partial: true };
			}
			entry.status = error instanceof BudgetStop ? "skipped_budget" : "failed";
			entry.problem = translationProblem(error, ctx);
			run.discoveryNotes.push({ provider: "translate", problem: `${entry.language}: ${entry.problem}`, scope: error instanceof BudgetStop ? "budget" : "error" });
		}
	}
	return { partial: true };
}

function firstSentence(text) {
	return String(text ?? "").split(/(?<=[.!?])\s/)[0].slice(0, 280);
}

// Why the run is held as a draft (docs/BRIEFINGS-DESIGN.md, The run, 9), the most serious reason first; null when it may send.
// A thin run, one where a provider failed or a step ran out of budget, and one with any blocker or warning never send.
export function holdReason({ run, work, briefing }) {
	if (run.thin) return "thin";
	if (work.partial) return "partial";
	if ((run.checks ?? []).some(({ status }) => status !== "pass")) return "checks";
	if ((briefing.reviewMode ?? "draft") !== "send_if_checks_pass") return "review_mode";
	return null;
}
