import "server-only";
import { randomBytes } from "node:crypto";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { dateOutput, findNewsletter, findTestRecipient, idInput, newsletterFilterInput, newsletterInput, toId, toIso } from "@/lib/actions/shared";
import { findOwnerEmail } from "@/lib/accounts";
import { addAiKey, checkAiKey, deleteAiKey, listAiKeys } from "@/lib/ai-keys";
import {
	AI_KEY_STATUSES,
	AI_PROVIDERS,
	BRIEFING_REVIEW_MODES,
	BRIEFING_RUN_STATUSES,
	BRIEFING_SOURCE_KINDS,
	BRIEFING_STAGES,
	BRIEFING_STATUSES,
	BRIEFING_STEPS,
	CHECK_STATUSES,
	DEFAULT_BUDGET_USD,
	DEFAULT_MAX_STORIES,
	DEFAULT_MIN_SCORE,
	DEFAULT_SCHEDULE,
	JUDGMENT_ONLY_PROVIDERS,
	MAX_AI_KEYS_PER_ACCOUNT,
	MAX_AUDIENCE_LENGTH,
	MAX_BRIEFINGS_PER_NEWSLETTER,
	MAX_BUDGET_USD,
	MAX_SOURCES,
	MAX_STORIES,
	MAX_STYLE_GUIDE_LENGTH,
} from "@/lib/briefing-rules";
import { describeBriefingSchedule, getBriefingScheduleProblem, nextBriefingRunAt, normalizeBriefingSchedule } from "@/lib/briefing-schedule";
import { getFeedUrlProblem } from "@/lib/feed-url";
import { READER_LANGUAGES } from "@/lib/reader-language-copy";
import { isObjectIdString, normalizeEmail } from "@/lib/validation";
import AiProviderKey from "@/models/AiProviderKey";
import Briefing from "@/models/Briefing";
import BriefingRun from "@/models/BriefingRun";
import BriefingSeen from "@/models/BriefingSeen";
import TeamSeat from "@/models/TeamSeat";

const GROUP = "Briefings";
const HOW_IT_WORKS = `A briefing belongs to a newsletter. On its schedule it reads its sources (RSS, Atom or JSON feeds, listing pages, single pages), picks the stories its audience cares about, reads the original pages, writes a short issue in the newsletter's style with every paragraph linked to its sources, checks the issue and saves it as a draft campaign for review, with a test email to testEmail. Each step (triage, extract, write, check) runs on a model of the account's own AI key (add_ai_key), so the model cost is the account's, capped by budgetUsd per run. A briefing never sends by itself: reviewMode draft is the only mode for now.`;

// Only where the region runs the briefings engine: its Worker (BRIEFINGS_ENABLED), or the hourly cron on a self-hosted server.
export function isBriefingsEngineOn(env = process.env) {
	return env.BRIEFINGS_ENABLED === "true" || env.BRIEFINGS_IN_CRON === "true";
}

// What a briefing reads, in one place: its schemas, how it is shown and stored, and its one validator. Provisional: a topic brief
// with open-web discovery is to replace the fixed list (pending the owner's approval of the design), and changes only this block.
const SourceSchema = z.object({
	id: z.string().describe("Stable for as long as the source is in the list"),
	kind: z.enum(BRIEFING_SOURCE_KINDS).describe("feed: RSS, Atom or JSON Feed. page: a listing page whose new links are the items. url: one page checked for change."),
	url: z.string(),
	label: z.string(),
	weight: z.number(),
});
const sourcesInput = z
	.array(
		z.object({
			id: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/).optional().describe("A stable id of your own (letters, digits, - and _). Default: kept from the source with the same address, else made up."),
			kind: z.enum(BRIEFING_SOURCE_KINDS).describe("feed: RSS, Atom or JSON Feed. page: a listing page whose new links are the items. url: one page checked for change."),
			url: z.string().trim().min(1).max(1000).describe("An https:// address on a public host"),
			label: z.string().trim().max(100).optional().describe("A name for the source, for the run history"),
			weight: z.number().min(0).max(10).optional().describe("How much its stories count in triage, 0 to 10, 1 by default"),
		})
	)
	.max(MAX_SOURCES)
	.describe(`What it reads, ${MAX_SOURCES} at most. Sending the list replaces it.`);

function toSources(sources) {
	return (sources ?? []).map(({ id, kind, url, label, weight }) => ({ id, kind, url, label: label ?? "", weight: weight ?? 1 }));
}

// Sources as sent, each with a stable id: the one it was given, else the one the same address had, else a new one.
function mergeSources(sources, current = []) {
	const byUrl = new Map(current.map((source) => [source.url, source.id]));
	return sources.map((source) => {
		const url = String(source.url ?? "").trim();
		return { id: source.id || byUrl.get(url) || `src_${randomBytes(5).toString("hex")}`, kind: source.kind, url, label: (source.label ?? "").trim(), weight: source.weight ?? 1 };
	});
}

function hasSources(sources) {
	return sources.length > 0;
}

function getSourcesProblem(sources) {
	const ids = new Set();
	const urls = new Set();
	for (const [index, source] of sources.entries()) {
		const problem = getFeedUrlProblem(source.url);
		if (problem) return `Source ${index + 1}: ${problem}`;
		if (ids.has(source.id)) return `Source ${index + 1}: another source has the id ${source.id}`;
		if (urls.has(source.url)) return `Source ${index + 1}: that address is in the list already`;
		ids.add(source.id);
		urls.add(source.url);
	}
	return null;
}

const StepSchema = z
	.object({
		keyId: z.string(),
		keyName: z.string().nullable().describe("The AI key's name, null when it was deleted"),
		keyHint: z.string().nullable().describe("The key's last four characters"),
		provider: z.enum(AI_PROVIDERS).nullable(),
		model: z.string(),
	})
	.nullable();
const RunSchema = z.object({
	id: z.string(),
	briefingId: z.string(),
	newsletterId: z.string(),
	slot: z.string().describe("The local day the run was due (YYYY-MM-DD), or manual:<time> for run_briefing"),
	isManual: z.boolean(),
	stage: z.enum(BRIEFING_STAGES),
	status: z.enum(BRIEFING_RUN_STATUSES).describe("running; drafted (a draft campaign waits for review); sent; no_news (nothing scored high enough); stopped_at_budget (the next model call would have passed budgetUsd); failed (see error)"),
	counts: z.object({ sources: z.number(), fetched: z.number(), fresh: z.number(), groups: z.number(), picked: z.number() }),
	sourceErrors: z.array(z.object({ sourceId: z.string(), problem: z.string() })),
	stories: z.array(z.object({ externalId: z.string(), title: z.string(), url: z.string(), score: z.number().nullable(), sources: z.array(z.string()) })),
	calls: z.array(
		z.object({
			step: z.string(),
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
	campaignId: z.string().nullable().describe("The draft campaign it made"),
	error: z.string().nullable(),
	startedAt: dateOutput,
	finishedAt: dateOutput,
	createdAt: dateOutput,
});
const BriefingSchema = z.object({
	id: z.string(),
	newsletterId: z.string(),
	name: z.string(),
	status: z.enum(BRIEFING_STATUSES).describe("paused makes nothing and has no next run"),
	sources: z.array(SourceSchema),
	schedule: z.object({ days: z.array(z.number().int()).describe("1 (Monday) to 7 (Sunday)"), time: z.string().describe("HH:MM in timeZone"), timeZone: z.string() }),
	scheduleSummary: z.string().describe("The schedule in words"),
	audience: z.string(),
	styleGuide: z.string(),
	languages: z.array(z.enum(READER_LANGUAGES)).describe("The issue is written in the first; the others are offered to readers through reader translation (beta)"),
	maxStories: z.number().int(),
	minScore: z.number().int(),
	steps: z.object({ triage: StepSchema, extract: StepSchema, write: StepSchema, check: StepSchema }).describe("Which AI key and model each step uses, never the key"),
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
	provider: z.enum(AI_PROVIDERS),
	providerLabel: z.string(),
	baseUrl: z.string().nullable().describe("openai-compatible only: the server's address"),
	accountRef: z.string().nullable().describe("cloudflare only: the Cloudflare account ID"),
	hint: z.string().describe("The key's last four characters, to tell keys apart. The key itself is never shown again."),
	status: z.enum(AI_KEY_STATUSES).describe("unchecked; ok (the provider took it at the last check); rejected (it refused it)"),
	checkedAt: dateOutput,
	lastUsedAt: dateOutput,
	usedBy: z.number().int().describe("How many briefings' steps use it; a key in use can't be deleted"),
	createdAt: dateOutput,
});

function toRun(run) {
	const counts = run.counts ?? {};
	return {
		id: String(run._id),
		briefingId: String(run.briefingId),
		newsletterId: String(run.newsletterId),
		slot: run.slot,
		isManual: Boolean(run.isManual),
		stage: run.stage ?? "collect",
		status: run.status ?? "running",
		counts: { sources: counts.sources ?? 0, fetched: counts.fetched ?? 0, fresh: counts.fresh ?? 0, groups: counts.groups ?? 0, picked: counts.picked ?? 0 },
		sourceErrors: (run.sourceErrors ?? []).map(({ sourceId, problem }) => ({ sourceId: sourceId ?? "", problem: problem ?? "" })),
		stories: (run.stories ?? []).map((story) => ({ externalId: story.externalId ?? "", title: story.title ?? "", url: story.url ?? "", score: story.score ?? null, sources: story.sources ?? [] })),
		calls: (run.calls ?? []).map((call) => ({
			step: call.step ?? "",
			provider: call.provider ?? "",
			model: call.model ?? "",
			inputTokens: call.inputTokens ?? 0,
			outputTokens: call.outputTokens ?? 0,
			costUsd: call.costUsd ?? 0,
			costFrom: call.costFrom ?? null,
		})),
		costUsd: run.costUsd ?? 0,
		checks: (run.checks ?? []).map(({ id, status, message }) => ({ id: id ?? "", status, message: message ?? "" })),
		campaignId: toId(run.campaignId),
		error: run.error ?? null,
		startedAt: toIso(run.startedAt),
		finishedAt: toIso(run.finishedAt),
		createdAt: toIso(run.createdAt),
	};
}

function toStep(step, keys) {
	if (!step?.keyId) return null;
	const key = keys.get(String(step.keyId));
	return { keyId: String(step.keyId), keyName: key?.name ?? null, keyHint: key?.hint ?? null, provider: key?.provider ?? null, model: step.model ?? "" };
}

function toSchedule(schedule) {
	return { days: schedule?.days?.length ? [...schedule.days] : [...DEFAULT_SCHEDULE.days], time: schedule?.time ?? DEFAULT_SCHEDULE.time, timeZone: schedule?.timeZone || "UTC" };
}

function toBriefing(briefing, keys, lastRun = null) {
	const schedule = toSchedule(briefing.schedule);
	return {
		id: String(briefing._id),
		newsletterId: String(briefing.newsletterId),
		name: briefing.name,
		status: briefing.status ?? "paused",
		sources: toSources(briefing.sources),
		schedule,
		scheduleSummary: describeBriefingSchedule(schedule),
		audience: briefing.audience ?? "",
		styleGuide: briefing.styleGuide ?? "",
		languages: briefing.languages?.length ? [...briefing.languages] : ["en"],
		maxStories: briefing.maxStories ?? DEFAULT_MAX_STORIES,
		minScore: briefing.minScore ?? DEFAULT_MIN_SCORE,
		steps: Object.fromEntries(BRIEFING_STEPS.map((step) => [step, toStep(briefing.steps?.[step], keys)])),
		prices: (briefing.prices ?? []).map(({ model, inputPerMillion, outputPerMillion }) => ({ model, inputPerMillion: inputPerMillion ?? null, outputPerMillion: outputPerMillion ?? null })),
		budgetUsd: briefing.budgetUsd ?? DEFAULT_BUDGET_USD,
		reviewMode: briefing.reviewMode ?? "draft",
		testEmail: briefing.testEmail ?? null,
		nextRunAt: toIso(briefing.nextRunAt),
		manualRunAt: toIso(briefing.manualRunAt),
		lastRunAt: toIso(briefing.lastRunAt),
		lastRun: lastRun ? toRun(lastRun) : null,
		createdAt: toIso(briefing.createdAt),
		updatedAt: toIso(briefing.updatedAt),
	};
}

// The account's keys by id, as the steps show them. The ciphertext is never selected.
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
	return toBriefing(briefing, map, lastRun);
}

// The addresses a test email may go to: the owner's and the active team members'.
async function findTeamEmails(account) {
	const [owner, seats] = await Promise.all([findOwnerEmail(account._id), TeamSeat.find(scoped(account, { status: "active" })).select({ email: 1 }).lean()]);
	return new Set([owner, ...seats.map(({ email }) => email)].filter(Boolean).map((email) => email.toLowerCase()));
}

const DEFAULTS = {
	status: "paused",
	sources: [],
	audience: "",
	styleGuide: "",
	languages: ["en"],
	maxStories: DEFAULT_MAX_STORIES,
	minScore: DEFAULT_MIN_SCORE,
	steps: { triage: null, extract: null, write: null, check: null },
	prices: [],
	budgetUsd: DEFAULT_BUDGET_USD,
	reviewMode: "draft",
	testEmail: null,
};

function fromDocument(briefing) {
	return {
		name: briefing.name,
		status: briefing.status ?? "paused",
		sources: toSources(briefing.sources),
		schedule: toSchedule(briefing.schedule),
		audience: briefing.audience ?? "",
		styleGuide: briefing.styleGuide ?? "",
		languages: briefing.languages?.length ? [...briefing.languages] : ["en"],
		maxStories: briefing.maxStories ?? DEFAULT_MAX_STORIES,
		minScore: briefing.minScore ?? DEFAULT_MIN_SCORE,
		steps: Object.fromEntries(BRIEFING_STEPS.map((step) => [step, briefing.steps?.[step]?.keyId ? { keyId: String(briefing.steps[step].keyId), model: briefing.steps[step].model ?? "" } : null])),
		prices: briefing.prices ?? [],
		budgetUsd: briefing.budgetUsd ?? DEFAULT_BUDGET_USD,
		reviewMode: briefing.reviewMode ?? "draft",
		testEmail: briefing.testEmail ?? null,
	};
}

// The settings as the rules read them: what is stored (or the defaults), with the changes on top. A step sent as null is cleared.
function toSettings(current, changes) {
	const base = current ? fromDocument(current) : { ...DEFAULTS, schedule: { ...DEFAULT_SCHEDULE } };
	const given = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined));
	const schedule = { ...base.schedule, ...Object.fromEntries(Object.entries(changes.schedule ?? {}).filter(([, value]) => value !== undefined)) };
	const steps = { ...base.steps };
	for (const step of BRIEFING_STEPS) {
		if (changes.steps && changes.steps[step] !== undefined) steps[step] = changes.steps[step] ? { keyId: changes.steps[step].keyId, model: changes.steps[step].model.trim() } : null;
	}
	return {
		...base,
		...given,
		schedule,
		steps,
		sources: changes.sources ? mergeSources(changes.sources, base.sources) : base.sources,
		...(given.languages && { languages: [...new Set(given.languages)] }),
		...(given.testEmail !== undefined && { testEmail: given.testEmail ? (normalizeEmail(given.testEmail) ?? given.testEmail.trim().toLowerCase()) : null }),
	};
}

function sameModel(a, b) {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

// What is wrong with a briefing's settings, or null. keys: the account's keys by id. teamEmails: checked only when testEmail is.
function getBriefingProblem(settings, keys, teamEmails) {
	if (!settings.name?.trim()) return "Name the briefing";
	const sourcesProblem = getSourcesProblem(settings.sources);
	if (sourcesProblem) return sourcesProblem;
	const scheduleProblem = getBriefingScheduleProblem(settings.schedule);
	if (scheduleProblem) return scheduleProblem;
	if (settings.languages.length === 0 || !settings.languages.every((language) => READER_LANGUAGES.includes(language))) return `Choose the languages from ${READER_LANGUAGES.join(", ")}`;
	if (settings.reviewMode !== "draft") return "Sending by itself once every check passes isn't available yet: keep reviewMode draft, and each issue waits for your review";
	for (const step of BRIEFING_STEPS) {
		const chosen = settings.steps[step];
		if (!chosen) continue;
		const key = keys.get(String(chosen.keyId));
		if (!key) return `The ${step} step's AI key isn't one of this account's: add it with add_ai_key, or choose another`;
		if (!chosen.model) return `Name the model the ${step} step uses`;
		if (JUDGMENT_ONLY_PROVIDERS.includes(key.provider) && !["triage", "check"].includes(step)) return `A TypeSafe key can score stories and check claims, not ${step === "write" ? "write" : "extract"}: choose another key for the ${step} step`;
	}
	const { write, check } = settings.steps;
	if (write && check && keys.get(String(write.keyId))?.provider === keys.get(String(check.keyId))?.provider && sameModel(write.model, check.model)) {
		return "The check step has to use another model than the write step, so a model never checks its own work";
	}
	if (settings.status === "active") {
		if (!hasSources(settings.sources)) return "Add a source before turning the briefing on";
		if (BRIEFING_STEPS.some((step) => !settings.steps[step])) return "Choose a key and a model for all four steps (triage, extract, write, check) before turning the briefing on";
	}
	if (settings.testEmail && teamEmails && !teamEmails.has(settings.testEmail)) return "The test email goes to you or a member of your team: use one of their addresses";
	return null;
}

function toDocument(settings) {
	return {
		name: settings.name.trim(),
		status: settings.status,
		sources: settings.sources,
		schedule: normalizeBriefingSchedule(settings.schedule),
		audience: settings.audience.trim(),
		styleGuide: settings.styleGuide.trim(),
		languages: settings.languages,
		maxStories: settings.maxStories,
		minScore: settings.minScore,
		steps: Object.fromEntries(BRIEFING_STEPS.filter((step) => settings.steps[step]).map((step) => [step, { keyId: settings.steps[step].keyId, model: settings.steps[step].model }])),
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
		keyId: idInput("AI key").describe("One of the account's AI keys (list_ai_keys)"),
		model: z.string().trim().min(1).max(200).describe("The model's name at its provider, like gpt-4.1-mini or jev-latest"),
	})
	.nullable()
	.optional();

const fields = {
	name: z.string().trim().min(1).max(100).describe("What the briefing is called in the dashboard"),
	status: z.enum(BRIEFING_STATUSES).describe("active runs on the schedule, which needs a source and all four steps; paused (the default for a new one) makes nothing"),
	sources: sourcesInput,
	schedule: z
		.object({
			days: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional().describe(`The days it runs, 1 (Monday) to 7 (Sunday). Default ${DEFAULT_SCHEDULE.days.join(", ")}.`),
			time: z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().describe(`HH:MM in timeZone. Default ${DEFAULT_SCHEDULE.time}.`),
			timeZone: z.string().trim().max(64).optional().describe("An IANA time zone like Europe/Paris. Default UTC."),
		})
		.describe("When it runs; fields left out keep their value"),
	audience: z.string().max(MAX_AUDIENCE_LENGTH).describe(`Who reads the newsletter and what they care about, in plain text, ${MAX_AUDIENCE_LENGTH.toLocaleString("en-US")} characters at most. Triage scores stories against it.`),
	styleGuide: z.string().max(MAX_STYLE_GUIDE_LENGTH).describe(`How the issue is written: voice, length, structure, words to avoid, ${MAX_STYLE_GUIDE_LENGTH.toLocaleString("en-US")} characters at most`),
	languages: z.array(z.enum(READER_LANGUAGES)).min(1).max(READER_LANGUAGES.length).describe(`The issue is written in the first; the others are offered to readers through reader translation (beta). From ${READER_LANGUAGES.join(", ")}. Default en.`),
	maxStories: z.number().int().min(1).max(MAX_STORIES).describe(`The most stories an issue has, ${DEFAULT_MAX_STORIES} by default, ${MAX_STORIES} at most`),
	minScore: z.number().int().min(0).max(100).describe(`The triage score, 0 to 100, a story needs to be in the issue. Default ${DEFAULT_MIN_SCORE}.`),
	steps: z
		.object({ triage: stepInput, extract: stepInput, write: stepInput, check: stepInput })
		.describe("The AI key and model of each step; null clears one. A TypeSafe key works for triage and check only, and check must use another model than write."),
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
	budgetUsd: z.number().positive().max(MAX_BUDGET_USD).describe(`The most a run may spend on model calls, in USD: ${DEFAULT_BUDGET_USD} by default, ${MAX_BUDGET_USD} at most. A call that would pass it isn't made, and the run stops.`),
	reviewMode: z.enum(BRIEFING_REVIEW_MODES).describe("draft (the only mode for now): each issue waits as a draft for review. send_if_checks_pass isn't available yet."),
	testEmail: z.string().trim().max(254).nullable().describe("Where the test email of each run goes: the owner's or a team member's address. Default: yours."),
};

const listBriefings = defineAction({
	name: "list_briefings",
	title: "List briefings",
	group: GROUP,
	description: `Lists the account's briefings, oldest first, each with its sources, schedule, steps and latest run. ${HOW_IT_WORKS}`,
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
	description: "Shows one briefing: its sources, schedule, audience, style guide, the AI key (by name and last four characters, never the key) and model of each step, its budget and its latest run.",
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
	description: `Creates a briefing for a newsletter, ${MAX_BRIEFINGS_PER_NEWSLETTER} per newsletter. It is paused until status is active, which needs a source and a key and model for all four steps. ${HOW_IT_WORKS}`,
	http: { method: "POST", path: "/briefings", status: 201 },
	rateLimit: { limit: 30, window: "1 h" },
	example: { name: "Morning briefing", sources: [{ kind: "feed", url: "https://example.com/feed.xml" }], schedule: { days: [1, 2, 3, 4, 5], time: "06:00", timeZone: "Europe/Paris" }, audience: "Product managers at small software companies" },
	input: z.object({
		newsletter: newsletterInput,
		name: fields.name,
		status: fields.status.optional(),
		sources: fields.sources.optional(),
		schedule: fields.schedule.optional(),
		audience: fields.audience.optional(),
		styleGuide: fields.styleGuide.optional(),
		languages: fields.languages.optional(),
		maxStories: fields.maxStories.optional(),
		minScore: fields.minScore.optional(),
		steps: fields.steps.optional(),
		prices: fields.prices.optional(),
		budgetUsd: fields.budgetUsd.optional(),
		reviewMode: fields.reviewMode.optional(),
		testEmail: fields.testEmail.optional(),
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
	description: `Changes a briefing's sources, schedule, audience, style guide, languages, steps, prices, budget, test email or status. Send only the fields to change: schedule and steps keep the fields you leave out, sources replaces the list (a source keeps its id when its address stays). Turning it on, or changing its schedule while it is on, sets its next run from now. ${HOW_IT_WORKS}`,
	http: { method: "PATCH", path: "/briefings/{id}" },
	idempotent: true,
	example: { budgetUsd: 0.5, steps: { check: { keyId: "6650f1c2e9b1d4a012345678", model: "jev-latest" } } },
	input: z.object({
		id: idInput("briefing"),
		name: fields.name.optional(),
		status: fields.status.optional(),
		sources: fields.sources.optional(),
		schedule: fields.schedule.optional(),
		audience: fields.audience.optional(),
		styleGuide: fields.styleGuide.optional(),
		languages: fields.languages.optional(),
		maxStories: fields.maxStories.optional(),
		minScore: fields.minScore.optional(),
		steps: fields.steps.optional(),
		prices: fields.prices.optional(),
		budgetUsd: fields.budgetUsd.optional(),
		reviewMode: fields.reviewMode.optional(),
		testEmail: fields.testEmail.optional(),
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
	description: "Turns a paused briefing back on, with its next run worked out from now. It needs a source and a key and model for all four steps.",
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
	description: "Deletes a briefing with its run history and what it remembered having read. The campaigns and content items it made stay.",
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
		return { id: input.id, deleted: true };
	},
});

const runBriefing = defineAction({
	name: "run_briefing",
	title: "Run a briefing now",
	group: GROUP,
	description: "Asks for a run now, whatever the schedule and whether the briefing is paused: the engine takes it within about 10 minutes and the result is a draft campaign, never a send, with the run in the history (list_briefing_runs). It needs a source and all four steps. Where the server doesn't run the briefings engine it answers unavailable.",
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
		await Briefing.updateOne(scoped(account, { _id: briefing._id }), { $set: { manualRunAt: new Date() } });
		return showBriefing(account, await findBriefing(account, input.id), keys);
	},
});

const listBriefingRuns = defineAction({
	name: "list_briefing_runs",
	title: "List a briefing's runs",
	group: GROUP,
	description: "Lists a briefing's latest runs, newest first: what each read, the stories it picked, each model call and its cost, the checks and the draft it made, or why it stopped.",
	http: { method: "GET", path: "/briefings/{id}/runs" },
	readOnly: true,
	input: z.object({ id: idInput("briefing"), limit: z.number().int().min(1).max(100).optional().describe("Runs to list, 30 by default, 100 at most") }),
	output: z.object({ runs: z.array(RunSchema) }),
	handler: async ({ account, input }) => {
		const briefing = await findBriefing(account, input.id);
		const runs = await BriefingRun.find(scoped(account, { briefingId: briefing._id })).select({ work: 0 }).sort({ createdAt: -1, _id: -1 }).limit(input.limit ?? 30).lean();
		return { runs: runs.map(toRun) };
	},
});

const getBriefingRun = defineAction({
	name: "get_briefing_run",
	title: "Get a briefing run",
	group: GROUP,
	description: "Shows one run of a briefing: its stage and status, counts, source errors, stories, model calls with their cost, checks, and the draft campaign it made.",
	http: { method: "GET", path: "/briefing-runs/{id}" },
	readOnly: true,
	input: z.object({ id: idInput("run") }),
	output: RunSchema,
	handler: async ({ account, input }) => {
		const run = isObjectIdString(input.id) ? await BriefingRun.findOne(scoped(account, { _id: input.id })).select({ work: 0 }).lean() : null;
		if (!run) throw actionError("not_found", "Run not found");
		return toRun(run);
	},
});

const addAiKeyAction = defineAction({
	name: "add_ai_key",
	title: "Add an AI key",
	group: GROUP,
	description: `Saves the account's own key for an AI provider, encrypted, for its briefings' steps; ${MAX_AI_KEYS_PER_ACCOUNT} at most. The answer has the key's last four characters only: the key is never shown again, by any action. Add keys in the dashboard (AI keys) rather than through an agent when you can, so the key doesn't pass through a model's context. Its status is unchecked until check_ai_key.`,
	http: { method: "POST", path: "/ai-keys", status: 201 },
	rateLimit: { limit: 20, window: "1 h" },
	example: { name: "OpenRouter", provider: "openrouter", key: "sk-or-v1-example" },
	input: z.object({
		name: z.string().trim().min(1).max(60).describe("What the key is called, to choose it for a step"),
		provider: z.enum(AI_PROVIDERS).describe("Who the key is for. openai-compatible is any server with the OpenAI API at baseUrl; typesafe works for triage and check only."),
		key: z.string().min(1).max(600).describe("The key as the provider shows it. It is encrypted at once and never shown again."),
		baseUrl: z.string().trim().max(500).optional().describe("openai-compatible only: the server's https address, like https://llm.example.com/v1, on a public host and the default port"),
		accountRef: z.string().trim().max(64).optional().describe("cloudflare only: your Cloudflare account ID (32 characters), whose Workers AI the key uses"),
	}),
	output: AiKeySchema,
	handler: async ({ account, input, user, apiKey }) => addAiKey(account, input, { createdBy: user?.id ?? (apiKey ? `key:${apiKey._id}` : null) }),
});

const listAiKeysAction = defineAction({
	name: "list_ai_keys",
	title: "List AI keys",
	group: GROUP,
	description: "Lists the account's AI keys, oldest first: name, provider, last four characters, whether the provider took it at the last check, and how many briefings use it. Never the key.",
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
	description: "Makes one small authenticated request to the key's provider (its list of models, which costs nothing) and saves whether it took the key: ok, or rejected. A provider that doesn't answer leaves the status as it was and answers unavailable.",
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
	description: "Deletes an AI key: its encrypted copy is gone at once. Refused while a briefing's step uses it; choose another key for that step first.",
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
	addAiKeyAction,
	listAiKeysAction,
	checkAiKeyAction,
	deleteAiKeyAction,
];
