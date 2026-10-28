import "server-only";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { dateOutput, findNewsletter, findTestRecipient, idInput, newsletterFilterInput, newsletterInput, toId, toIso } from "@/lib/actions/shared";
import { findOwnerEmail } from "@/lib/accounts";
import { ALL_KEY_PROVIDERS, addAiKey, checkAiKey, deleteAiKey, isSearchProvider, listAiKeys } from "@/lib/ai-keys";
import {
	AI_KEY_STATUSES,
	BRIEFING_REVIEW_MODES,
	BRIEFING_RUN_STATUSES,
	BRIEFING_STAGES,
	BRIEFING_STATUSES,
	BRIEFING_STEPS,
	CHECK_STATUSES,
	DEFAULT_BUDGET_USD,
	DEFAULT_DISCOVERY,
	DEFAULT_MIN_SCORE,
	DEFAULT_SCHEDULE,
	DEFAULT_STEP_BUDGETS,
	DEFAULT_STORIES,
	DISCOVERY_MAXIMUMS,
	HOLD_REASONS,
	JUDGMENT_ONLY_PROVIDERS,
	MAX_AI_KEYS_PER_ACCOUNT,
	MAX_AUDIENCE_LENGTH,
	MAX_BLOCKED_HOSTS,
	MAX_BRIEFINGS_PER_NEWSLETTER,
	MAX_BRIEF_ITEMS,
	MAX_BUDGET_USD,
	MAX_SECTIONS,
	MAX_SECTION_ITEMS,
	MAX_SECTION_PURPOSE_LENGTH,
	MAX_SECTION_TITLE_LENGTH,
	MAX_EXAMPLES,
	MAX_FULL_STORIES,
	MAX_STYLE_GUIDE_LENGTH,
	MAX_TOPIC_LENGTH,
	MAX_TRUSTED_OUTLETS,
	MAX_USEFUL_LENGTH,
	SECTION_FORMATS,
	SECTION_STATUSES,
	SOURCE_KINDS,
	STORY_KINDS,
	VERDICTS,
} from "@/lib/briefing-rules";
import { countManualRunsToday, isOverManualRuns } from "@/lib/briefing-runs";
import { describeBriefingSchedule, getBriefingScheduleProblem, nextBriefingRunAt, normalizeBriefingSchedule } from "@/lib/briefing-schedule";
import { recordVerdict } from "@/lib/briefing-verdicts";
import { READER_LANGUAGES } from "@/lib/reader-language-copy";
import { isObjectIdString, normalizeEmail } from "@/lib/validation";
import { getWebhookUrlProblem } from "@/lib/webhook-url";
import AiProviderKey from "@/models/AiProviderKey";
import Briefing from "@/models/Briefing";
import BriefingPublisher from "@/models/BriefingPublisher";
import BriefingRun from "@/models/BriefingRun";
import BriefingSeen from "@/models/BriefingSeen";
import BriefingVerdict from "@/models/BriefingVerdict";
import TeamSeat from "@/models/TeamSeat";

const GROUP = "Briefings";
const HOW_IT_WORKS = `A briefing belongs to a newsletter. There is no list of sources: from its brief (a topic, the audience, what makes a story useful and example stories) it searches the open web on its schedule, with free indexes and the account's own search key if it has one, picks the stories its audience cares about, reads the original pages, writes a short issue in the newsletter's style with every paragraph linked to its sources, checks the issue and saves it as a draft campaign for review, with a test email to testEmail and a note to the owner with a keep or drop link per story. Each step (query, triage, extract, write, check, translate) runs on a model of the account's own AI key (add_ai_key), so the model cost is the account's, capped by budgetUsd per run and shared between the steps by stepBudgets. A briefing never sends by itself: reviewMode draft is the only mode for now.`;
// query, extract, write and translate write text; TypeSafe answers judgments, so it can only triage and check.
const JUDGMENT_STEPS = ["triage", "check"];
const HOST_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const STORY_KEY_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const SECTION_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

// Only where the region runs the briefings engine: its Worker (BRIEFINGS_ENABLED), or the hourly cron on a self-hosted server.
export function isBriefingsEngineOn(env = process.env) {
	return env.BRIEFINGS_ENABLED === "true" || env.BRIEFINGS_IN_CRON === "true";
}

// "example.com" for "Example.com.", "www.example.com": hosts are compared the way the engine reads a page's (lib/briefings/urls.js).
export function normalizeHost(value) {
	return String(value ?? "").trim().toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
}

const KeyRefSchema = z
	.object({
		keyId: z.string(),
		keyName: z.string().nullable().describe("The key's name, null when it was deleted"),
		keyHint: z.string().nullable().describe("The key's last four characters"),
		provider: z.enum(ALL_KEY_PROVIDERS).nullable(),
	})
	.nullable();
const StepSchema = z
	.object({
		keyId: z.string(),
		keyName: z.string().nullable().describe("The AI key's name, null when it was deleted"),
		keyHint: z.string().nullable().describe("The key's last four characters"),
		provider: z.enum(ALL_KEY_PROVIDERS).nullable(),
		model: z.string(),
	})
	.nullable();
const RunStorySchema = z.object({
	storyKey: z.string().describe("The story's id within the run, for rate_briefing_story"),
	externalId: z.string(),
	kind: z.enum(STORY_KINDS).nullable().describe("full: a paragraph or two. brief: a one-line item with its link."),
	title: z.string(),
	url: z.string(),
	sourceKind: z.enum(SOURCE_KINDS).nullable().describe("What its primary source is: reporting, a press release, a filing, a regulator, the company, a community"),
	score: z.number().nullable(),
	foundBy: z.array(z.string()).describe("The indexes and queries that found it"),
	sources: z.array(z.string()),
	verdict: z.enum(VERDICTS).nullable().describe("The owner's keep or drop, once given"),
	sectionId: z.string().nullable().describe("The section it went into, when the briefing has sections"),
});
const RunSchema = z.object({
	id: z.string(),
	briefingId: z.string(),
	newsletterId: z.string(),
	slot: z.string().describe("The local day the run was due (YYYY-MM-DD), or manual:<time> for run_briefing"),
	isManual: z.boolean(),
	stage: z.enum(BRIEFING_STAGES),
	status: z.enum(BRIEFING_RUN_STATUSES).describe("running; drafted (a draft campaign waits for review); sent; no_news (nothing scored high enough); stopped_at_budget (the next model call would have passed the budget); failed (see error)"),
	counts: z.object({ queries: z.number(), results: z.number(), candidates: z.number(), fresh: z.number(), groups: z.number(), shortlisted: z.number(), picked: z.number() }),
	queries: z.array(z.object({ text: z.string(), angle: z.string() })).describe("The searches discovery made, and the angle each covers"),
	discoveryNotes: z.array(z.object({ provider: z.string(), problem: z.string(), scope: z.string().nullable(), until: dateOutput })).describe("What discovery could not do: a limit reached, a path robots.txt refused, a provider error"),
	stories: z.array(RunStorySchema),
	sections: z
		.array(
			z.object({
				id: z.string(),
				title: z.string(),
				status: z.enum(SECTION_STATUSES).nullable().describe("written; empty (no story for it); skipped_budget (its share of the budget ran out); failed (see problem)"),
				items: z.number().int().describe("Stories written into it"),
				costUsd: z.number().describe("What its model calls cost, in USD"),
				problem: z.string().nullable(),
			})
		)
		.describe("Each section of the issue, in reading order, when the briefing has sections"),
	calls: z.array(
		z.object({
			step: z.string(),
			sectionId: z.string().nullable().describe("The section the call was for, when it was for one"),
			provider: z.string(),
			model: z.string(),
			inputTokens: z.number(),
			outputTokens: z.number(),
			costUsd: z.number(),
			costFrom: z.enum(["provider", "price_table"]).nullable().describe("provider: the cost the provider reported. price_table: tokens times the price."),
		})
	),
	costUsd: z.number().describe("What the run's model calls cost, in USD"),
	checks: z.array(z.object({ id: z.string(), status: z.enum(CHECK_STATUSES), message: z.string() })),
	languages: z.array(z.object({ language: z.string(), status: z.string() })).describe("Each translation the run wrote or skipped"),
	thin: z.boolean().describe("Discovery found fewer candidates than it should have, and the owner's note says why"),
	heldReason: z.enum(HOLD_REASONS).nullable().describe("Why a run that could have sent was kept as a draft"),
	campaignId: z.string().nullable().describe("The draft campaign it made"),
	error: z.string().nullable(),
	startedAt: dateOutput,
	finishedAt: dateOutput,
	createdAt: dateOutput,
});
const BriefSchema = z.object({
	topic: z.string(),
	audience: z.string(),
	useful: z.string().describe("What makes a story worth this audience's time"),
	examples: z.array(z.object({ url: z.string(), note: z.string() })),
});
const BriefingSchema = z.object({
	id: z.string(),
	newsletterId: z.string(),
	name: z.string(),
	status: z.enum(BRIEFING_STATUSES).describe("paused makes nothing and has no next run"),
	brief: BriefSchema,
	trustedOutlets: z.array(z.string()).describe("Hosts that add to a story's score and whose feeds are read each run; never a limit"),
	blockedHosts: z.array(z.string()).describe("Hosts never fetched or cited for this briefing"),
	discovery: z.object({
		searchKey: KeyRefSchema.describe("The account's own search key (TinyFish), or null for the free indexes only"),
		candidateFeedKey: KeyRefSchema.describe("A candidate feed's key, or null"),
		maxQueries: z.number().int(),
		resultsPerQuery: z.number().int(),
		maxCandidates: z.number().int(),
		shortlist: z.number().int(),
		followLinks: z.number().int(),
		discoveryBudgetUsd: z.number(),
	}),
	schedule: z.object({ days: z.array(z.number().int()).describe("1 (Monday) to 7 (Sunday)"), time: z.string().describe("HH:MM in timeZone"), timeZone: z.string() }),
	scheduleSummary: z.string().describe("The schedule in words"),
	styleGuide: z.string(),
	languages: z.array(z.enum(READER_LANGUAGES)).describe("The issue is written in the first; the translate step writes the others, for readers who choose them (beta)"),
	stories: z.object({ minFull: z.number().int(), maxFull: z.number().int(), briefItems: z.number().int() }),
	sections: z
		.array(
			z.object({
				id: z.string(),
				title: z.string(),
				purpose: z.string(),
				format: z.enum(SECTION_FORMATS),
				maxItems: z.number().int(),
				budgetShare: z.number().int().nullable(),
				priority: z.number().int().nullable(),
			})
		)
		.describe("The issue's sections in reading order; empty for the layout of full stories then one-line items"),
	minScore: z.number().int(),
	steps: z.object(Object.fromEntries(BRIEFING_STEPS.map((step) => [step, StepSchema]))).describe("Which AI key and model each step uses, never the key"),
	stepBudgets: z.object(Object.fromEntries(BRIEFING_STEPS.map((step) => [step, z.number()]))).describe("Each step's share of budgetUsd, in percent"),
	prices: z.array(z.object({ model: z.string(), inputPerMillion: z.number().nullable(), outputPerMillion: z.number().nullable() })),
	budgetUsd: z.number(),
	reviewMode: z.enum(BRIEFING_REVIEW_MODES),
	testEmail: z.string().nullable(),
	nextRunAt: dateOutput.describe("When it is due next; null while paused"),
	manualRunAt: dateOutput.describe("A run asked for with run_briefing, waiting for the engine"),
	lastRunAt: dateOutput,
	lastRun: RunSchema.nullable(),
	createdAt: dateOutput,
	updatedAt: dateOutput,
});
const AiKeySchema = z.object({
	id: z.string(),
	name: z.string(),
	provider: z.enum(ALL_KEY_PROVIDERS),
	providerLabel: z.string(),
	kind: z.enum(["model", "search"]).describe("model keys run a briefing's steps, search keys its discovery"),
	baseUrl: z.string().nullable().describe("openai-compatible and candidate-feed only: the server's address"),
	accountRef: z.string().nullable().describe("cloudflare only: the Cloudflare account ID"),
	hint: z.string().describe("The key's last four characters, to tell keys apart. The key itself is never shown again."),
	status: z.enum(AI_KEY_STATUSES).describe("unchecked; ok (the provider took it at the last check); rejected (it refused it)"),
	checkedAt: dateOutput,
	lastUsedAt: dateOutput,
	usedBy: z.number().int().describe("How many briefings use it; a key in use can't be deleted"),
	createdAt: dateOutput,
});

function toRun(run, verdicts = new Map()) {
	const counts = run.counts ?? {};
	return {
		id: String(run._id),
		briefingId: String(run.briefingId),
		newsletterId: String(run.newsletterId),
		slot: run.slot,
		isManual: Boolean(run.isManual),
		stage: run.stage ?? "discover",
		status: run.status ?? "running",
		counts: Object.fromEntries(["queries", "results", "candidates", "fresh", "groups", "shortlisted", "picked"].map((name) => [name, counts[name] ?? 0])),
		queries: (run.queries ?? []).map(({ text, angle }) => ({ text: text ?? "", angle: angle ?? "" })),
		discoveryNotes: (run.discoveryNotes ?? []).map(({ provider, problem, scope, until }) => ({ provider: provider ?? "", problem: problem ?? "", scope: scope ?? null, until: toIso(until) })),
		stories: (run.stories ?? []).map((story) => ({
			storyKey: story.storyKey ?? "",
			externalId: story.externalId ?? "",
			kind: story.kind ?? null,
			title: story.title ?? "",
			url: story.url ?? "",
			sourceKind: story.sourceKind ?? null,
			score: story.score ?? null,
			foundBy: story.foundBy ?? [],
			sources: story.sources ?? [],
			verdict: verdicts.get(`${run._id}:${story.storyKey}`) ?? null,
			sectionId: story.sectionId ?? null,
		})),
		sections: (run.sections ?? []).map((section) => ({ id: section.id ?? "", title: section.title ?? "", status: section.status ?? null, items: section.items ?? 0, costUsd: section.costUsd ?? 0, problem: section.problem ?? null })),
		calls: (run.calls ?? []).map((call) => ({
			step: call.step ?? "",
			sectionId: call.sectionId ?? null,
			provider: call.provider ?? "",
			model: call.model ?? "",
			inputTokens: call.inputTokens ?? 0,
			outputTokens: call.outputTokens ?? 0,
			costUsd: call.costUsd ?? 0,
			costFrom: call.costFrom ?? null,
		})),
		costUsd: run.costUsd ?? 0,
		checks: (run.checks ?? []).map(({ id, status, message }) => ({ id: id ?? "", status, message: message ?? "" })),
		languages: (run.languages ?? []).map(({ language, status }) => ({ language: language ?? "", status: status ?? "" })),
		thin: Boolean(run.thin),
		heldReason: run.heldReason ?? null,
		campaignId: toId(run.campaignId),
		error: run.error ?? null,
		startedAt: toIso(run.startedAt),
		finishedAt: toIso(run.finishedAt),
		createdAt: toIso(run.createdAt),
	};
}

// The owner's verdicts on these runs' stories, "<runId>:<storyKey>" -> keep or drop.
async function loadVerdicts(account, runs) {
	if (runs.length === 0) return new Map();
	const verdicts = await BriefingVerdict.find(scoped(account, { runId: { $in: runs.map(({ _id }) => _id) } })).select({ runId: 1, storyKey: 1, verdict: 1 }).lean();
	return new Map(verdicts.map(({ runId, storyKey, verdict }) => [`${runId}:${storyKey}`, verdict]));
}

function toKeyRef(keyId, keys) {
	if (!keyId) return null;
	const key = keys.get(String(keyId));
	return { keyId: String(keyId), keyName: key?.name ?? null, keyHint: key?.hint ?? null, provider: key?.provider ?? null };
}

function toStep(step, keys) {
	const ref = toKeyRef(step?.keyId, keys);
	return ref && { ...ref, model: step.model ?? "" };
}

function toSchedule(schedule) {
	return { days: schedule?.days?.length ? [...schedule.days] : [...DEFAULT_SCHEDULE.days], time: schedule?.time ?? DEFAULT_SCHEDULE.time, timeZone: schedule?.timeZone || "UTC" };
}

function toBriefing(briefing, keys, lastRun = null, verdicts = new Map()) {
	const settings = fromDocument(briefing);
	const { searchKeyId, candidateFeedKeyId, ...widths } = settings.discovery;
	return {
		id: String(briefing._id),
		newsletterId: String(briefing.newsletterId),
		name: settings.name,
		status: settings.status,
		brief: settings.brief,
		trustedOutlets: settings.trustedOutlets,
		blockedHosts: settings.blockedHosts,
		discovery: { searchKey: toKeyRef(searchKeyId, keys), candidateFeedKey: toKeyRef(candidateFeedKeyId, keys), ...widths },
		schedule: settings.schedule,
		scheduleSummary: describeBriefingSchedule(settings.schedule),
		styleGuide: settings.styleGuide,
		languages: settings.languages,
		stories: settings.stories,
		sections: settings.sections.map(({ id, title, purpose, format, maxItems, budgetShare, priority }) => ({ id, title, purpose, format, maxItems, budgetShare: budgetShare ?? null, priority: priority ?? null })),
		minScore: settings.minScore,
		steps: Object.fromEntries(BRIEFING_STEPS.map((step) => [step, toStep(settings.steps[step], keys)])),
		stepBudgets: settings.stepBudgets,
		prices: settings.prices.map(({ model, inputPerMillion, outputPerMillion }) => ({ model, inputPerMillion: inputPerMillion ?? null, outputPerMillion: outputPerMillion ?? null })),
		budgetUsd: settings.budgetUsd,
		reviewMode: settings.reviewMode,
		testEmail: settings.testEmail,
		nextRunAt: toIso(briefing.nextRunAt),
		manualRunAt: toIso(briefing.manualRunAt),
		lastRunAt: toIso(briefing.lastRunAt),
		lastRun: lastRun ? toRun(lastRun, verdicts) : null,
		createdAt: toIso(briefing.createdAt),
		updatedAt: toIso(briefing.updatedAt),
	};
}

// The account's keys by id, as the steps and discovery show them. The ciphertext is never selected.
async function loadKeys(account) {
	const keys = await AiProviderKey.find(scoped(account)).select({ name: 1, provider: 1, hint: 1 }).lean();
	return new Map(keys.map((key) => [String(key._id), key]));
}

async function findBriefing(account, id) {
	const briefing = isObjectIdString(id) ? await Briefing.findOne(scoped(account, { _id: id })).lean() : null;
	if (!briefing) throw actionError("not_found", "Briefing not found");
	return briefing;
}

async function findLastRun(account, briefing) {
	const [run] = await BriefingRun.find(scoped(account, { briefingId: briefing._id })).select({ work: 0 }).sort({ createdAt: -1, _id: -1 }).limit(1).lean();
	return run ?? null;
}

async function showBriefing(account, briefing, keys = null) {
	const [map, lastRun] = await Promise.all([keys ?? loadKeys(account), findLastRun(account, briefing)]);
	return toBriefing(briefing, map, lastRun, await loadVerdicts(account, lastRun ? [lastRun] : []));
}

// The addresses a test email may go to: the owner's and the active team members'.
async function findTeamEmails(account) {
	const [owner, seats] = await Promise.all([findOwnerEmail(account._id), TeamSeat.find(scoped(account, { status: "active" })).select({ email: 1 }).lean()]);
	return new Set([owner, ...seats.map(({ email }) => email)].filter(Boolean).map((email) => email.toLowerCase()));
}

const pick = (object, names) => Object.fromEntries(names.map((name) => [name, object?.[name]]).filter(([, value]) => value !== undefined && value !== null));
const defined = (object) => Object.fromEntries(Object.entries(object ?? {}).filter(([, value]) => value !== undefined));
const DISCOVERY_WIDTHS = Object.keys(DEFAULT_DISCOVERY);

// A stored briefing in the shape the rules read, with the defaults where it has nothing.
function fromDocument(briefing) {
	const discovery = briefing?.discovery ?? {};
	return {
		name: briefing?.name ?? "",
		status: briefing?.status ?? "paused",
		brief: {
			topic: briefing?.brief?.topic ?? "",
			audience: briefing?.brief?.audience ?? "",
			useful: briefing?.brief?.useful ?? "",
			examples: (briefing?.brief?.examples ?? []).map(({ url, note }) => ({ url, note: note ?? "" })),
		},
		trustedOutlets: [...(briefing?.trustedOutlets ?? [])],
		blockedHosts: [...(briefing?.blockedHosts ?? [])],
		discovery: {
			searchKeyId: discovery.searchKeyId ? String(discovery.searchKeyId) : null,
			candidateFeedKeyId: discovery.candidateFeedKeyId ? String(discovery.candidateFeedKeyId) : null,
			...DEFAULT_DISCOVERY,
			...pick(discovery, DISCOVERY_WIDTHS),
		},
		schedule: toSchedule(briefing?.schedule),
		styleGuide: briefing?.styleGuide ?? "",
		languages: briefing?.languages?.length ? [...briefing.languages] : ["en"],
		stories: { ...DEFAULT_STORIES, ...pick(briefing?.stories, Object.keys(DEFAULT_STORIES)) },
		sections: (briefing?.sections ?? []).map(({ id, title, purpose, format, maxItems, budgetShare, priority }) => ({ id, title, purpose: purpose ?? "", format, maxItems, budgetShare: budgetShare ?? null, priority: priority ?? null })),
		minScore: briefing?.minScore ?? DEFAULT_MIN_SCORE,
		steps: Object.fromEntries(BRIEFING_STEPS.map((step) => [step, briefing?.steps?.[step]?.keyId ? { keyId: String(briefing.steps[step].keyId), model: briefing.steps[step].model ?? "" } : null])),
		stepBudgets: { ...DEFAULT_STEP_BUDGETS, ...pick(briefing?.stepBudgets, BRIEFING_STEPS) },
		prices: briefing?.prices ?? [],
		budgetUsd: briefing?.budgetUsd ?? DEFAULT_BUDGET_USD,
		reviewMode: briefing?.reviewMode ?? "draft",
		testEmail: briefing?.testEmail ?? null,
	};
}

// The settings as the rules read them: what is stored (or the defaults), with the changes on top. Nested objects keep the fields a
// change leaves out; a list sent replaces the list; a step or a discovery key sent as null is cleared.
function toSettings(current, changes) {
	const base = fromDocument(current);
	const given = defined(changes);
	const steps = { ...base.steps };
	for (const step of BRIEFING_STEPS) {
		const chosen = changes.steps?.[step];
		if (chosen !== undefined) steps[step] = chosen ? { keyId: chosen.keyId, model: chosen.model.trim() } : null;
	}
	return {
		...base,
		...given,
		brief: { ...base.brief, ...defined(changes.brief) },
		trustedOutlets: changes.trustedOutlets ? [...new Set(changes.trustedOutlets.map(normalizeHost))] : base.trustedOutlets,
		blockedHosts: changes.blockedHosts ? [...new Set(changes.blockedHosts.map(normalizeHost))] : base.blockedHosts,
		discovery: { ...base.discovery, ...defined(changes.discovery) },
		schedule: { ...base.schedule, ...defined(changes.schedule) },
		stories: { ...base.stories, ...defined(changes.stories) },
		sections: changes.sections ? changes.sections.map((section) => ({ ...section, id: section.id.trim().toLowerCase(), budgetShare: section.budgetShare ?? null, priority: section.priority ?? null })) : base.sections,
		steps,
		stepBudgets: { ...base.stepBudgets, ...defined(changes.stepBudgets) },
		...(given.languages && { languages: [...new Set(given.languages)] }),
		...(given.testEmail !== undefined && { testEmail: given.testEmail ? (normalizeEmail(given.testEmail) ?? given.testEmail.trim().toLowerCase()) : null }),
	};
}

function sameModel(a, b) {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

// The steps a briefing needs to run: all but translate, which it needs only when it writes more than one language.
export function getRequiredSteps(languages = []) {
	return BRIEFING_STEPS.filter((step) => step !== "translate" || languages.length > 1);
}

// What is wrong with the brief and the hosts, or null.
function getBriefProblem({ brief, trustedOutlets, blockedHosts }) {
	for (const [index, example] of brief.examples.entries()) {
		const problem = getWebhookUrlProblem(example.url);
		if (problem) return `Example ${index + 1}: ${problem}`;
	}
	for (const [label, hosts] of [["Trusted outlet", trustedOutlets], ["Blocked host", blockedHosts]]) {
		const index = hosts.findIndex((host) => !HOST_PATTERN.test(host));
		if (index !== -1) return `${label} ${index + 1}: write a host name like example.com, without https:// or a path`;
	}
	return null;
}

// What is wrong with the keys of the steps and of discovery, or null: each key is the account's, of the right kind for its place.
function getKeysProblem({ steps, discovery }, keys) {
	for (const step of BRIEFING_STEPS) {
		const chosen = steps[step];
		if (!chosen) continue;
		const key = keys.get(String(chosen.keyId));
		if (!key) return `The ${step} step's AI key isn't one of this account's: add it with add_ai_key, or choose another`;
		if (isSearchProvider(key.provider)) return `The ${step} step needs a model key, not a search key`;
		if (!chosen.model) return `Name the model the ${step} step uses`;
		if (JUDGMENT_ONLY_PROVIDERS.includes(key.provider) && !JUDGMENT_STEPS.includes(step)) return `A TypeSafe key can score stories and check claims, not write text: choose another key for the ${step} step`;
	}
	const { write, check } = steps;
	if (write && check && keys.get(String(write.keyId))?.provider === keys.get(String(check.keyId))?.provider && sameModel(write.model, check.model)) {
		return "The check step has to use another model than the write step, so a model never checks its own work";
	}
	for (const [field, wanted, label] of [["searchKeyId", "tinyfish", "search key"], ["candidateFeedKeyId", "candidate-feed", "candidate feed key"]]) {
		const id = discovery[field];
		if (!id) continue;
		const key = keys.get(String(id));
		if (!key) return `The ${label} isn't one of this account's: add it with add_ai_key, or choose another`;
		if (key.provider !== wanted) return `discovery.${field} needs a ${wanted === "tinyfish" ? "TinyFish" : "candidate feed"} key, not a ${isSearchProvider(key.provider) ? "key of another search provider" : "model key"}`;
	}
	return null;
}

// What is wrong with a briefing's settings, or null. keys: the account's keys by id. teamEmails: checked only when testEmail is.
// What is wrong with the sections, or null. Lengths, formats and bounds are the schema's.
function getSectionsProblem(sections) {
	const ids = new Set();
	for (const [index, section] of sections.entries()) {
		if (!SECTION_ID_PATTERN.test(section.id)) return `Section ${index + 1}: its id is lower-case letters, digits and dashes, like market-pulse`;
		if (ids.has(section.id)) return `Section ${index + 1}: another section has the id ${section.id}`;
		if (!section.title.trim()) return `Section ${index + 1}: give it a title`;
		ids.add(section.id);
	}
	const shares = sections.reduce((total, { budgetShare }) => total + (budgetShare ?? 0), 0);
	if (shares > 100) return `The sections' budget shares are percents of the extract and write budget and add up to 100 at most, not ${shares}`;
	return null;
}

function getBriefingProblem(settings, keys, teamEmails) {
	if (!settings.name?.trim()) return "Name the briefing";
	const briefProblem = getBriefProblem(settings);
	if (briefProblem) return briefProblem;
	const scheduleProblem = getBriefingScheduleProblem(settings.schedule);
	if (scheduleProblem) return scheduleProblem;
	if (settings.languages.length === 0 || !settings.languages.every((language) => READER_LANGUAGES.includes(language))) return `Choose the languages from ${READER_LANGUAGES.join(", ")}`;
	if (settings.stories.minFull > settings.stories.maxFull) return "stories.minFull can't be more than stories.maxFull";
	const sectionsProblem = getSectionsProblem(settings.sections);
	if (sectionsProblem) return sectionsProblem;
	const shares = BRIEFING_STEPS.reduce((total, step) => total + settings.stepBudgets[step], 0);
	if (Math.abs(shares - 100) > 1e-9) return `The step budgets are shares of budgetUsd in percent and add up to 100, not ${shares}`;
	if (settings.reviewMode !== "draft") return "Sending by itself once every check passes isn't available yet: keep reviewMode draft, and each issue waits for your review";
	const keysProblem = getKeysProblem(settings, keys);
	if (keysProblem) return keysProblem;
	if (settings.status === "active") {
		if (!settings.brief.topic.trim()) return "Write the brief's topic before turning the briefing on";
		const missing = getRequiredSteps(settings.languages).filter((step) => !settings.steps[step]);
		if (missing.length > 0) return `Choose a key and a model for the ${missing.join(", ")} ${missing.length === 1 ? "step" : "steps"} before turning the briefing on`;
	}
	if (settings.testEmail && teamEmails && !teamEmails.has(settings.testEmail)) return "The test email goes to you or a member of your team: use one of their addresses";
	return null;
}

function toDocument(settings) {
	const { searchKeyId, candidateFeedKeyId, ...widths } = settings.discovery;
	return {
		name: settings.name.trim(),
		status: settings.status,
		brief: {
			topic: settings.brief.topic.trim(),
			audience: settings.brief.audience.trim(),
			useful: settings.brief.useful.trim(),
			examples: settings.brief.examples.map(({ url, note }) => ({ url: url.trim(), note: (note ?? "").trim() })),
		},
		trustedOutlets: settings.trustedOutlets,
		blockedHosts: settings.blockedHosts,
		discovery: { ...(searchKeyId && { searchKeyId }), ...(candidateFeedKeyId && { candidateFeedKeyId }), ...pick(widths, DISCOVERY_WIDTHS) },
		schedule: normalizeBriefingSchedule(settings.schedule),
		styleGuide: settings.styleGuide.trim(),
		languages: settings.languages,
		stories: settings.stories,
		sections: settings.sections.map(({ id, title, purpose, format, maxItems, budgetShare, priority }) => ({ id, title: title.trim(), purpose: (purpose ?? "").trim(), format, maxItems, ...(budgetShare !== null && budgetShare !== undefined && { budgetShare }), ...(priority !== null && priority !== undefined && { priority }) })),
		minScore: settings.minScore,
		steps: Object.fromEntries(BRIEFING_STEPS.filter((step) => settings.steps[step]).map((step) => [step, { keyId: settings.steps[step].keyId, model: settings.steps[step].model }])),
		stepBudgets: settings.stepBudgets,
		prices: settings.prices.map(({ model, inputPerMillion, outputPerMillion }) => ({ model: model.trim(), ...(inputPerMillion !== undefined && inputPerMillion !== null && { inputPerMillion }), ...(outputPerMillion !== undefined && outputPerMillion !== null && { outputPerMillion }) })),
		budgetUsd: settings.budgetUsd,
		reviewMode: settings.reviewMode,
		...(settings.testEmail && { testEmail: settings.testEmail }),
	};
}

async function checkSettings(account, settings, { checkEmail }) {
	const keys = await loadKeys(account);
	const teamEmails = checkEmail && settings.testEmail ? await findTeamEmails(account) : null;
	const problem = getBriefingProblem(settings, keys, teamEmails);
	if (problem) throw actionError("validation_failed", problem);
	return keys;
}

const stepInput = z
	.object({
		keyId: idInput("AI key").describe("One of the account's model keys (list_ai_keys)"),
		model: z.string().trim().min(1).max(200).describe("The model's name at its provider, like gpt-4.1-mini or jev-latest"),
	})
	.nullable()
	.optional();
const hostsInput = (max, what) => z.array(z.string().trim().min(1).max(253)).max(max).describe(`${what}, ${max} at most, as host names (example.com). Sending the list replaces it.`);
const width = (name, min, what) => z.number().int().min(min).max(DISCOVERY_MAXIMUMS[name]).optional().describe(`${what}: ${DEFAULT_DISCOVERY[name]} by default, ${DISCOVERY_MAXIMUMS[name]} at most`);

const fields = {
	name: z.string().trim().min(1).max(100).describe("What the briefing is called in the dashboard"),
	status: z.enum(BRIEFING_STATUSES).describe("active runs on the schedule, which needs the brief's topic and a key and model for every step it uses; paused (the default for a new one) makes nothing"),
	brief: z
		.object({
			topic: z.string().max(MAX_TOPIC_LENGTH).optional().describe(`What the briefing is about, ${MAX_TOPIC_LENGTH} characters at most. Discovery searches from it.`),
			audience: z.string().max(MAX_AUDIENCE_LENGTH).optional().describe(`Who reads it and what they care about, ${MAX_AUDIENCE_LENGTH.toLocaleString("en-US")} characters at most`),
			useful: z.string().max(MAX_USEFUL_LENGTH).optional().describe(`What makes a story worth their time, ${MAX_USEFUL_LENGTH.toLocaleString("en-US")} characters at most`),
			examples: z
				.array(z.object({ url: z.string().trim().min(1).max(1000).describe("An https:// story the owner would have wanted"), note: z.string().trim().max(300).optional().describe("Why it is a good one") }))
				.max(MAX_EXAMPLES)
				.optional()
				.describe(`Stories you would have wanted, ${MAX_EXAMPLES} at most: discovery searches like them and the ranker starts from them. Sending the list replaces it.`),
		})
		.describe("What to look for, instead of a list of sources; fields left out keep their value"),
	trustedOutlets: hostsInput(MAX_TRUSTED_OUTLETS, "Outlets whose stories score higher and whose feeds are read each run, never a limit on what is searched"),
	blockedHosts: hostsInput(MAX_BLOCKED_HOSTS, "Hosts never fetched or cited for this briefing, whatever their robots.txt says"),
	discovery: z
		.object({
			searchKeyId: idInput("search key").nullable().optional().describe("The account's TinyFish key (list_ai_keys, kind search), used under its holder's own TinyFish account and terms; null for the free indexes only"),
			candidateFeedKeyId: idInput("candidate feed key").nullable().optional().describe("A candidate-feed key: an https JSON list of candidates read with a bearer key; null for none"),
			maxQueries: width("maxQueries", 1, "Searches per run"),
			resultsPerQuery: width("resultsPerQuery", 1, "Results kept per search"),
			maxCandidates: width("maxCandidates", 1, "Candidates kept after merging"),
			shortlist: width("shortlist", 1, "Stories ranked into the shortlist"),
			followLinks: width("followLinks", 0, "Outbound links followed per strong article"),
			discoveryBudgetUsd: z.number().min(0).max(DISCOVERY_MAXIMUMS.discoveryBudgetUsd).optional().describe(`What paid search may cost per run, in USD: 0 by default, which keeps discovery on free indexes and free tiers; ${DISCOVERY_MAXIMUMS.discoveryBudgetUsd} at most`),
		})
		.describe("How wide discovery searches, and with which keys; fields left out keep their value"),
	schedule: z
		.object({
			days: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional().describe(`The days it runs, 1 (Monday) to 7 (Sunday). Default ${DEFAULT_SCHEDULE.days.join(", ")}.`),
			time: z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().describe(`HH:MM in timeZone. Default ${DEFAULT_SCHEDULE.time}.`),
			timeZone: z.string().trim().max(64).optional().describe("An IANA time zone like Europe/Paris. Default UTC."),
		})
		.describe("When it runs; fields left out keep their value"),
	styleGuide: z.string().max(MAX_STYLE_GUIDE_LENGTH).describe(`How the issue is written: voice, length, structure, words to avoid, ${MAX_STYLE_GUIDE_LENGTH.toLocaleString("en-US")} characters at most`),
	languages: z.array(z.enum(READER_LANGUAGES)).min(1).max(READER_LANGUAGES.length).describe(`The issue is written in the first; the translate step writes the others for readers who choose them (beta). From ${READER_LANGUAGES.join(", ")}. Default en.`),
	stories: z
		.object({
			minFull: z.number().int().min(1).max(MAX_FULL_STORIES).optional().describe(`The fewest full stories (a paragraph or two each) an issue has when enough score high: ${DEFAULT_STORIES.minFull} by default`),
			maxFull: z.number().int().min(1).max(MAX_FULL_STORIES).optional().describe(`The most full stories: ${DEFAULT_STORIES.maxFull} by default, ${MAX_FULL_STORIES} at most`),
			briefItems: z.number().int().min(0).max(MAX_BRIEF_ITEMS).optional().describe(`One-line items with a link after the full stories: ${DEFAULT_STORIES.briefItems} by default, ${MAX_BRIEF_ITEMS} at most`),
		})
		.describe("How many stories an issue has; fields left out keep their value"),
	sections: z
		.array(
			z.object({
				id: z.string().trim().min(1).max(40).describe("A stable id for the section: lower-case letters, digits and dashes, like market-pulse"),
				title: z.string().trim().min(1).max(MAX_SECTION_TITLE_LENGTH).describe(`Its heading in the issue, ${MAX_SECTION_TITLE_LENGTH} characters at most`),
				purpose: z.string().trim().max(MAX_SECTION_PURPOSE_LENGTH).optional().describe(`What belongs in it, ${MAX_SECTION_PURPOSE_LENGTH} characters at most: stories are assigned to the section whose purpose they fit`),
				format: z.enum(SECTION_FORMATS).describe("sentences: a sentence or two per story, with its numbers. one-liners: one sourced line per story."),
				maxItems: z.number().int().min(1).max(MAX_SECTION_ITEMS).describe(`The most stories it holds, 1 to ${MAX_SECTION_ITEMS}`),
				budgetShare: z.number().int().min(0).max(100).nullable().optional().describe("Its percent of the extract and write steps' budget. The shares given add up to 100 at most; without any, the budget is split evenly between the sections."),
				priority: z.number().int().min(1).max(MAX_SECTIONS).nullable().optional().describe(`Which sections are written first when the budget runs short, 1 first (to ${MAX_SECTIONS}); without one, the reading order decides`),
			})
		)
		.max(MAX_SECTIONS)
		.describe(`The issue as a labelled skeleton of sections, in reading order, ${MAX_SECTIONS} at most. Sending the list replaces it; [] goes back to full stories then one-line items (stories). A section with no story is left out of the issue.`),
	minScore: z.number().int().min(0).max(100).describe(`The score, 0 to 100, a story needs to be a full story. Default ${DEFAULT_MIN_SCORE}.`),
	steps: z
		.object(Object.fromEntries(BRIEFING_STEPS.map((step) => [step, stepInput])))
		.describe("The model key and model of each step; null clears one. translate is needed only with more than one language. A TypeSafe key works for triage and check only, and check must use another model than write."),
	stepBudgets: z
		.object(Object.fromEntries(BRIEFING_STEPS.map((step) => [step, z.number().int().min(0).max(100).optional().describe(`Percent of budgetUsd, ${DEFAULT_STEP_BUDGETS[step]} by default`)])))
		.describe("Each step's share of budgetUsd in percent; the six add up to 100. Fields left out keep their value."),
	prices: z
		.array(
			z.object({
				model: z.string().trim().min(1).max(200).describe("The model's name, as in steps"),
				inputPerMillion: z.number().min(0).max(1000).nullable().optional().describe("USD per million input tokens"),
				outputPerMillion: z.number().min(0).max(1000).nullable().optional().describe("USD per million output tokens"),
			})
		)
		.max(20)
		.describe("Prices for models the built-in price table doesn't have, or to override it. A model with no known price can't run under the budget."),
	budgetUsd: z.number().positive().max(MAX_BUDGET_USD).describe(`The most a run may spend on model calls, in USD: ${DEFAULT_BUDGET_USD} by default, ${MAX_BUDGET_USD} at most. A call that would pass it isn't made.`),
	reviewMode: z.enum(BRIEFING_REVIEW_MODES).describe("draft (the only mode for now): each issue waits as a draft for review. send_if_checks_pass isn't available yet."),
	testEmail: z.string().trim().max(254).nullable().describe("Where the test email of each run goes: the owner's or a team member's address. Default: yours."),
};

const SETTING_FIELDS = ["status", "brief", "trustedOutlets", "blockedHosts", "discovery", "schedule", "styleGuide", "languages", "stories", "sections", "minScore", "steps", "stepBudgets", "prices", "budgetUsd", "reviewMode", "testEmail"];
const optionalSettings = Object.fromEntries(SETTING_FIELDS.map((name) => [name, fields[name].optional()]));

const listBriefings = defineAction({
	name: "list_briefings",
	title: "List briefings",
	group: GROUP,
	description: `Lists the account's briefings, oldest first, each with its brief, schedule, steps and latest run. ${HOW_IT_WORKS}`,
	http: { method: "GET", path: "/briefings" },
	readOnly: true,
	input: z.object({ newsletter: newsletterFilterInput }),
	output: z.object({ briefings: z.array(BriefingSchema) }),
	handler: async ({ account, input }) => {
		const newsletter = input.newsletter ? await findNewsletter(account, input.newsletter, { _id: 1 }) : null;
		const [briefings, keys] = await Promise.all([Briefing.find(scoped(account, newsletter ? { newsletterId: newsletter._id } : {})).sort({ createdAt: 1, _id: 1 }).lean(), loadKeys(account)]);
		return { briefings: await Promise.all(briefings.map((briefing) => showBriefing(account, briefing, keys))) };
	},
});

const getBriefing = defineAction({
	name: "get_briefing",
	title: "Get a briefing",
	group: GROUP,
	description: "Shows one briefing: its brief, trusted and blocked hosts, discovery settings, schedule, style guide, the key (by name and last four characters, never the key) and model of each step, its budgets and its latest run.",
	http: { method: "GET", path: "/briefings/{id}" },
	readOnly: true,
	input: z.object({ id: idInput("briefing") }),
	output: BriefingSchema,
	handler: async ({ account, input }) => showBriefing(account, await findBriefing(account, input.id)),
});

const createBriefing = defineAction({
	name: "create_briefing",
	title: "Create a briefing",
	group: GROUP,
	description: `Creates a briefing for a newsletter, ${MAX_BRIEFINGS_PER_NEWSLETTER} per newsletter. It is paused until status is active, which needs the brief's topic and a key and model for each step it uses. ${HOW_IT_WORKS}`,
	http: { method: "POST", path: "/briefings", status: 201 },
	rateLimit: { limit: 30, window: "1 h" },
	example: { name: "Morning briefing", brief: { topic: "Battery manufacturing in Europe", audience: "Engineers and buyers at small battery companies", useful: "New plants, prices and rules that change what they build or buy" }, trustedOutlets: ["example.com"], schedule: { days: [1, 2, 3, 4, 5], time: "06:00", timeZone: "Europe/Paris" } },
	input: z.object({
		newsletter: newsletterInput,
		name: fields.name,
		...optionalSettings,
	}),
	output: BriefingSchema,
	handler: async ({ account, input, user }) => {
		const newsletter = await findNewsletter(account, input.newsletter, { _id: 1 });
		const { newsletter: _reference, ...changes } = input;
		const settings = toSettings(null, changes);
		if (!settings.testEmail) settings.testEmail = (await findTestRecipient({ account, user }))?.toLowerCase() ?? null;
		const keys = await checkSettings(account, settings, { checkEmail: changes.testEmail !== undefined });
		if ((await Briefing.countDocuments(scoped(account, { newsletterId: newsletter._id }))) >= MAX_BRIEFINGS_PER_NEWSLETTER) {
			throw actionError("conflict", `A newsletter has ${MAX_BRIEFINGS_PER_NEWSLETTER === 1 ? "one briefing" : `${MAX_BRIEFINGS_PER_NEWSLETTER} briefings`} at most`);
		}
		const document = toDocument(settings);
		const briefing = await Briefing.create({
			accountId: account._id,
			newsletterId: newsletter._id,
			...document,
			...(document.status === "active" && { nextRunAt: nextBriefingRunAt(document.schedule) }),
		});
		return toBriefing(briefing.toObject(), keys);
	},
});

const updateBriefing = defineAction({
	name: "update_briefing",
	title: "Update a briefing",
	group: GROUP,
	description: `Changes a briefing's brief, hosts, discovery, schedule, style guide, languages, story counts, sections, steps, budgets, test email or status. Send only the fields to change: brief, discovery, schedule, stories, steps and stepBudgets keep the fields you leave out, and a list sent (examples, trustedOutlets, blockedHosts, sections, prices) replaces the list; sections [] goes back to the unsectioned layout. Turning it on, or changing its schedule while it is on, sets its next run from now. ${HOW_IT_WORKS}`,
	http: { method: "PATCH", path: "/briefings/{id}" },
	idempotent: true,
	example: { budgetUsd: 0.5, steps: { check: { keyId: "6650f1c2e9b1d4a012345678", model: "jev-latest" } } },
	input: z.object({
		id: idInput("briefing"),
		name: fields.name.optional(),
		...optionalSettings,
	}),
	output: BriefingSchema,
	handler: async ({ account, input }) => {
		const current = await findBriefing(account, input.id);
		const { id: _id, ...changes } = input;
		const settings = toSettings(current, changes);
		const keys = await checkSettings(account, settings, { checkEmail: changes.testEmail !== undefined && settings.testEmail !== current.testEmail });
		const document = toDocument(settings);
		const isActive = document.status === "active";
		const rescheduled = changes.schedule !== undefined || current.status !== "active" || !current.nextRunAt;
		const unset = { ...(!isActive && { nextRunAt: 1 }), ...(!document.testEmail && { testEmail: 1 }) };
		const { matchedCount } = await Briefing.updateOne(scoped(account, { _id: current._id }), {
			$set: { ...document, ...(isActive && rescheduled && { nextRunAt: nextBriefingRunAt(document.schedule) }) },
			...(Object.keys(unset).length > 0 && { $unset: unset }),
		});
		if (!matchedCount) throw actionError("not_found", "Briefing not found");
		return showBriefing(account, await findBriefing(account, input.id), keys);
	},
});

const pauseBriefing = defineAction({
	name: "pause_briefing",
	title: "Pause a briefing",
	group: GROUP,
	description: "Pauses a briefing: it makes nothing until resume_briefing, and a manual run waiting for the engine is dropped. A run already going finishes.",
	http: { method: "POST", path: "/briefings/{id}/pause" },
	idempotent: true,
	whileBlocked: true,
	input: z.object({ id: idInput("briefing") }),
	output: BriefingSchema,
	handler: async ({ account, input }) => {
		const briefing = await findBriefing(account, input.id);
		await Briefing.updateOne(scoped(account, { _id: briefing._id }), { $set: { status: "paused" }, $unset: { nextRunAt: 1, manualRunAt: 1 } });
		return showBriefing(account, await findBriefing(account, input.id));
	},
});

const resumeBriefing = defineAction({
	name: "resume_briefing",
	title: "Resume a briefing",
	group: GROUP,
	description: "Turns a paused briefing back on, with its next run worked out from now. It needs the brief's topic and a key and model for each step it uses.",
	http: { method: "POST", path: "/briefings/{id}/resume" },
	idempotent: true,
	input: z.object({ id: idInput("briefing") }),
	output: BriefingSchema,
	handler: async ({ account, input }) => {
		const briefing = await findBriefing(account, input.id);
		const settings = { ...fromDocument(briefing), status: "active" };
		const keys = await checkSettings(account, settings, { checkEmail: false });
		await Briefing.updateOne(scoped(account, { _id: briefing._id }), { $set: { status: "active", nextRunAt: nextBriefingRunAt(normalizeBriefingSchedule(settings.schedule)) } });
		return showBriefing(account, await findBriefing(account, input.id), keys);
	},
});

const deleteBriefing = defineAction({
	name: "delete_briefing",
	title: "Delete a briefing",
	group: GROUP,
	description: "Deletes a briefing with its run history, what it remembered having read, its verdicts and what it learned about publishers. The campaigns and content items it made stay.",
	http: { method: "DELETE", path: "/briefings/{id}" },
	destructive: true,
	idempotent: true,
	input: z.object({ id: idInput("briefing") }),
	output: z.object({ id: z.string(), deleted: z.literal(true) }),
	handler: async ({ account, input }) => {
		const briefing = await findBriefing(account, input.id);
		await Briefing.deleteOne(scoped(account, { _id: briefing._id }));
		await BriefingRun.deleteMany(scoped(account, { briefingId: briefing._id }));
		await BriefingSeen.deleteMany(scoped(account, { briefingId: briefing._id }));
		await BriefingVerdict.deleteMany(scoped(account, { briefingId: briefing._id }));
		await BriefingPublisher.deleteMany(scoped(account, { briefingId: briefing._id }));
		return { id: input.id, deleted: true };
	},
});

const runBriefing = defineAction({
	name: "run_briefing",
	title: "Run a briefing now",
	group: GROUP,
	description: "Asks for a run now, whatever the schedule and whether the briefing is paused: the engine takes it within about 10 minutes and the result is a draft campaign, never a send, with the run in the history (list_briefing_runs). It needs the brief's topic and a key and model for each step it uses. Three manual runs a briefing per local day; a fourth answers rate_limited. Where the server doesn't run the briefings engine it answers unavailable.",
	http: { method: "POST", path: "/briefings/{id}/run" },
	openWorld: true,
	rateLimit: { limit: 6, window: "1 h" },
	limitDashboard: true,
	input: z.object({ id: idInput("briefing") }),
	output: BriefingSchema,
	handler: async ({ account, input }) => {
		const briefing = await findBriefing(account, input.id);
		if (!isBriefingsEngineOn()) throw actionError("unavailable", "Briefings don't run on this server yet: it needs the briefings Worker, or BRIEFINGS_IN_CRON=true when self-hosted");
		const settings = fromDocument(briefing);
		const keys = await checkSettings(account, { ...settings, status: "active" }, { checkEmail: false });
		if (isOverManualRuns(await countManualRunsToday(briefing))) throw actionError("rate_limited", "This briefing has had its 3 manual runs today; the next one can be asked for tomorrow, by the schedule's time zone");
		await Briefing.updateOne(scoped(account, { _id: briefing._id }), { $set: { manualRunAt: new Date() } });
		return showBriefing(account, await findBriefing(account, input.id), keys);
	},
});

const listBriefingRuns = defineAction({
	name: "list_briefing_runs",
	title: "List a briefing's runs",
	group: GROUP,
	description: "Lists a briefing's latest runs, newest first: the searches it made, what discovery could not do, the stories it picked with the owner's verdicts, each model call and its cost, the checks and the draft it made, or why it stopped.",
	http: { method: "GET", path: "/briefings/{id}/runs" },
	readOnly: true,
	input: z.object({ id: idInput("briefing"), limit: z.number().int().min(1).max(100).optional().describe("Runs to list, 30 by default, 100 at most") }),
	output: z.object({ runs: z.array(RunSchema) }),
	handler: async ({ account, input }) => {
		const briefing = await findBriefing(account, input.id);
		const runs = await BriefingRun.find(scoped(account, { briefingId: briefing._id })).select({ work: 0 }).sort({ createdAt: -1, _id: -1 }).limit(input.limit ?? 30).lean();
		const verdicts = await loadVerdicts(account, runs);
		return { runs: runs.map((run) => toRun(run, verdicts)) };
	},
});

const getBriefingRun = defineAction({
	name: "get_briefing_run",
	title: "Get a briefing run",
	group: GROUP,
	description: "Shows one run of a briefing: its stage and status, counts, searches, discovery notes, stories with the owner's verdicts, model calls with their cost, checks, translations, and the draft campaign it made.",
	http: { method: "GET", path: "/briefing-runs/{id}" },
	readOnly: true,
	input: z.object({ id: idInput("run") }),
	output: RunSchema,
	handler: async ({ account, input }) => {
		const run = isObjectIdString(input.id) ? await BriefingRun.findOne(scoped(account, { _id: input.id })).select({ work: 0 }).lean() : null;
		if (!run) throw actionError("not_found", "Run not found");
		return toRun(run, await loadVerdicts(account, [run]));
	},
});

const rateBriefingStory = defineAction({
	name: "rate_briefing_story",
	title: "Rate a briefing story",
	group: GROUP,
	description: "Records the owner's keep or drop on one story of a run, with what the ranker saw when it scored it, and counts it for the story's publisher. The ranker learns its weights from these verdicts, so later runs pick more stories like the kept ones. Rating a story again replaces its verdict. It changes nothing in the draft.",
	http: { method: "POST", path: "/briefing-runs/{id}/stories/{storyKey}/verdict" },
	idempotent: true,
	example: { verdict: "keep" },
	input: z.object({
		id: idInput("run"),
		storyKey: z.string().trim().regex(STORY_KEY_PATTERN).describe("The story's storyKey, from get_briefing_run"),
		verdict: z.enum(VERDICTS).describe("keep: more like this. drop: fewer like this."),
	}),
	output: z.object({ runId: z.string(), storyKey: z.string(), verdict: z.enum(VERDICTS), decidedAt: dateOutput }),
	handler: async ({ account, input, user, apiKey }) => {
		const result = await recordVerdict({ account, runId: input.id, storyKey: input.storyKey, verdict: input.verdict, decidedBy: user?.id ? String(user.id) : apiKey ? `key:${apiKey._id}` : null });
		return { runId: input.id, storyKey: input.storyKey, verdict: result.verdict, decidedAt: toIso(result.decidedAt) };
	},
});

const addAiKeyAction = defineAction({
	name: "add_ai_key",
	title: "Add an AI key",
	group: GROUP,
	description: `Saves the account's own key for an AI provider (for its briefings' steps) or a search provider (for discovery: TinyFish, used under the key holder's own TinyFish account and terms, or a candidate feed), encrypted; ${MAX_AI_KEYS_PER_ACCOUNT} at most. The answer has the key's last four characters only: the key is never shown again, by any action. Add keys in the dashboard (AI keys) rather than through an agent when you can, so the key doesn't pass through a model's context. Its status is unchecked until check_ai_key.`,
	http: { method: "POST", path: "/ai-keys", status: 201 },
	rateLimit: { limit: 20, window: "1 h" },
	example: { name: "OpenRouter", provider: "openrouter", key: "sk-or-v1-example" },
	input: z.object({
		name: z.string().trim().min(1).max(60).describe("What the key is called, to choose it for a step"),
		provider: z.enum(ALL_KEY_PROVIDERS).describe("Who the key is for. openai-compatible is any server with the OpenAI API at baseUrl; typesafe works for triage and check only; tinyfish and candidate-feed are search keys for discovery."),
		key: z.string().min(1).max(600).describe("The key as the provider shows it. It is encrypted at once and never shown again."),
		baseUrl: z.string().trim().max(500).optional().describe("openai-compatible and candidate-feed only: the server's https address, like https://llm.example.com/v1, on a public host and the default port"),
		accountRef: z.string().trim().max(64).optional().describe("cloudflare only: your Cloudflare account ID (32 characters), whose Workers AI the key uses"),
	}),
	output: AiKeySchema,
	handler: async ({ account, input, user, apiKey }) => addAiKey(account, input, { createdBy: user?.id ?? (apiKey ? `key:${apiKey._id}` : null) }),
});

const listAiKeysAction = defineAction({
	name: "list_ai_keys",
	title: "List AI keys",
	group: GROUP,
	description: "Lists the account's AI and search keys, oldest first: name, provider, kind, last four characters, whether the provider took it at the last check, and how many briefings use it. Never the key.",
	http: { method: "GET", path: "/ai-keys" },
	readOnly: true,
	input: z.object({}),
	output: z.object({ keys: z.array(AiKeySchema) }),
	handler: async ({ account }) => ({ keys: await listAiKeys(account) }),
});

const checkAiKeyAction = defineAction({
	name: "check_ai_key",
	title: "Check an AI key",
	group: GROUP,
	description: "Makes one small authenticated request to the key's provider (its list of models, TinyFish's list of runs, or the candidate feed itself, none of which is a paid call) and saves whether it took the key: ok, or rejected. A provider that doesn't answer leaves the status as it was and answers unavailable.",
	http: { method: "POST", path: "/ai-keys/{id}/check" },
	openWorld: true,
	rateLimit: { limit: 30, window: "1 h" },
	input: z.object({ id: idInput("AI key") }),
	output: z.object({ key: AiKeySchema, problem: z.string().nullable().describe("Why the provider refused it, when it did") }),
	handler: async ({ account, input }) => checkAiKey(account, input.id),
});

const deleteAiKeyAction = defineAction({
	name: "delete_ai_key",
	title: "Delete an AI key",
	group: GROUP,
	description: "Deletes an AI or search key: its encrypted copy is gone at once. Refused while a briefing's step or discovery uses it; choose another key there first.",
	http: { method: "DELETE", path: "/ai-keys/{id}" },
	destructive: true,
	idempotent: true,
	input: z.object({ id: idInput("AI key") }),
	output: z.object({ id: z.string(), deleted: z.literal(true) }),
	handler: async ({ account, input }) => deleteAiKey(account, input.id),
});

export const briefingActions = [
	listBriefings,
	getBriefing,
	createBriefing,
	updateBriefing,
	pauseBriefing,
	resumeBriefing,
	deleteBriefing,
	runBriefing,
	listBriefingRuns,
	getBriefingRun,
	rateBriefingStory,
	addAiKeyAction,
	listAiKeysAction,
	checkAiKeyAction,
	deleteAiKeyAction,
];
