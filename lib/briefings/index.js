import { scoped } from "../account-scope.js";
import { isDeletionPending } from "../account-state.js";
import { returnAiRequest, takeAiRequest } from "../ai-usage.js";
import { getBriefingSlot, nextBriefingRunAt } from "../briefing-schedule.js";
import { DEFAULT_BUDGET_USD, DEFAULT_MAX_STORIES, DEFAULT_MIN_SCORE, MAX_STORIES } from "../briefing-rules.js";
import { connectDb } from "../db.js";
import Account from "../../models/Account.js";
import Briefing from "../../models/Briefing.js";
import BriefingRun from "../../models/BriefingRun.js";
import BriefingSeen from "../../models/BriefingSeen.js";
import { claimChecks, codeChecks } from "./check.js";
import { DEDUPE, dedupeItems, toItem } from "./dedupe.js";
import { loadKeyStore } from "./deps.js";
import { extractStory } from "./extract.js";
import { createFetcher } from "./fetch.js";
import { embedItems, groupItems } from "./group.js";
import { BudgetStop, createMeter } from "./meter.js";
import { callModel, callTypeSafe, scrubSecret } from "./providers.js";
import { pickStories, scoreStories } from "./triage.js";
import { hostOf } from "./urls.js";
import { linkCitations, sectionFor, writeDraft } from "./write.js";

// The briefings engine (docs/BRIEFINGS-DESIGN.md, Where the engine runs and The run). A tick, every 10 minutes from the
// briefings Worker's Cron Trigger (or the hourly cron on a self-hosted server), claims the briefings that are due and the
// manual runs asked for, then moves each running run on stage by stage while its time lasts, saving after every stage, so a
// run cut off by the end of a tick goes on at the next. The unique (briefingId, slot) of BriefingRun is the lock that keeps a
// slot from running twice, as SeriesRun's is for series (lib/series.js).
export const TICK = { claimLimit: 25, resumeLimit: 20, staleMs: 60 * 60_000, runsPerAccountHour: 3, leaseExtraMs: 60_000, deliverAttempts: 3, maxRunMs: 6 * 60 * 60_000 };
const SEEN_BATCH = 100;
const SUCCESS = new Set(["drafted", "sent", "no_news"]);

function describe(error, secrets) {
	let message = String(error?.message || error || "Something went wrong");
	for (const secret of secrets) message = scrubSecret(message, secret);
	return scrubSecret(message, "").slice(0, 300);
}

async function isOverHourlyCap(accountId, now) {
	const since = new Date(now.getTime() - 60 * 60_000);
	return (await BriefingRun.countDocuments(scoped(accountId, { createdAt: { $gte: since } }))) >= TICK.runsPerAccountHour;
}

// Creates the run for a slot, or answers null when the slot already has one.
async function startRun({ briefing, slot, isManual, now }) {
	try {
		return await BriefingRun.create({
			accountId: briefing.accountId,
			briefingId: briefing._id,
			newsletterId: briefing.newsletterId,
			slot,
			isManual,
			stage: "discover",
			status: "running",
			counts: { sources: 0, fetched: 0, fresh: 0, groups: 0, picked: 0 },
			work: {},
			startedAt: now,
			touchedAt: now,
		});
	} catch (error) {
		if (error?.code === 11000) return null;
		throw error;
	}
}

// Due briefings are claimed by moving nextRunAt on in the same write that checks nobody else did, as runDueSeries does.
async function claimScheduled({ now, nextRunAt, started }) {
	const due = await Briefing.find({ status: "active", nextRunAt: { $lte: now } })
		.sort({ nextRunAt: 1 })
		.limit(TICK.claimLimit)
		.setOptions({ crossAccount: true })
		.lean();
	let claimed = 0;
	for (const briefing of due) {
		if (await isOverHourlyCap(briefing.accountId, now)) continue;
		const next = await nextRunAt(briefing.schedule, now);
		const { modifiedCount } = await Briefing.updateOne(
			{ accountId: briefing.accountId, _id: briefing._id, status: "active", nextRunAt: briefing.nextRunAt },
			{ $set: { nextRunAt: next ?? null } }
		);
		if (!modifiedCount) continue;
		const run = await startRun({ briefing, slot: getBriefingSlot(briefing.schedule, new Date(briefing.nextRunAt)), isManual: false, now });
		if (run) {
			started.push(run._id);
			claimed += 1;
		}
	}
	return claimed;
}

async function claimManual({ now, started }) {
	const asked = await Briefing.find({ manualRunAt: { $lte: now } })
		.sort({ manualRunAt: 1 })
		.limit(TICK.claimLimit)
		.setOptions({ crossAccount: true })
		.lean();
	let claimed = 0;
	for (const briefing of asked) {
		if (await isOverHourlyCap(briefing.accountId, now)) continue;
		const { modifiedCount } = await Briefing.updateOne({ accountId: briefing.accountId, _id: briefing._id, manualRunAt: briefing.manualRunAt }, { $unset: { manualRunAt: 1 } });
		if (!modifiedCount) continue;
		const run = await startRun({ briefing, slot: `manual:${new Date(briefing.manualRunAt).toISOString()}`, isManual: true, now });
		if (run) {
			started.push(run._id);
			claimed += 1;
		}
	}
	return claimed;
}

// A run nobody touched for an hour (the Worker was off, or kept dying in one stage) is given up, and so is one still going
// after six hours of ticks.
async function failStale({ now }) {
	const untouched = await BriefingRun.find({ status: "running", touchedAt: { $lt: new Date(now.getTime() - TICK.staleMs) } })
		.limit(50)
		.setOptions({ crossAccount: true })
		.lean();
	const endless = await BriefingRun.find({ status: "running", startedAt: { $lt: new Date(now.getTime() - TICK.maxRunMs) } })
		.limit(50)
		.setOptions({ crossAccount: true })
		.lean();
	let finished = 0;
	const seen = new Set();
	for (const run of [...untouched, ...endless]) {
		if (seen.has(String(run._id))) continue;
		seen.add(String(run._id));
		const { modifiedCount } = await BriefingRun.updateOne(
			{ accountId: run.accountId, _id: run._id, status: "running", touchedAt: run.touchedAt },
			{ $set: { status: "failed", stage: "done", error: "The run stopped without finishing, so it was given up", finishedAt: now }, $unset: { work: 1 } }
		);
		finished += modifiedCount ? 1 : 0;
	}
	return finished;
}

async function markSeen({ run, work, now }) {
	const storyOf = work.storyOf ?? {};
	const docs = new Map();
	for (const item of work.fresh ?? []) docs.set(item.urlHash, storyOf[item.urlHash] ?? null);
	const rows = [...docs].map(([urlHash, storyKey]) => ({ accountId: run.accountId, briefingId: run.briefingId, urlHash, ...(storyKey && { storyKey }), firstSeenAt: now }));
	for (let start = 0; start < rows.length; start += SEEN_BATCH) await BriefingSeen.insertMany(rows.slice(start, start + SEEN_BATCH), { ordered: false });
}

function firstSentence(text) {
	return String(text ?? "").split(/(?<=[.!?])\s/)[0].slice(0, 280);
}

function storiesForDelivery({ briefingId, records, markdown }) {
	return records.map((record) => ({
		externalId: `briefing:${briefingId}:${record.urlHash}`,
		title: record.title,
		hook: firstSentence(record.what) || record.title,
		body: linkCitations(sectionFor(markdown, record), records) || record.what,
		url: record.url,
		references: [
			{ label: record.label || hostOf(record.url), url: record.url, kind: "original" },
			...(record.primaryUrl ? [{ label: hostOf(record.primaryUrl), url: record.primaryUrl, kind: "primary" }] : []),
			...(record.coverage ?? []).map(({ url }) => ({ label: hostOf(url), url, kind: "coverage" })),
		],
	}));
}

// Each stage reads the run's working data and answers { next }, { partial } (saved, more of the same stage to do) or
// { finish: status }.
const STAGES = {
	// Discovery is handed in (runTick's discover): it answers what it found, and the engine keeps what is new.
	async discover(ctx) {
		const { run, briefing, work } = ctx;
		if (typeof ctx.discover !== "function") throw new Error("No discovery is set up for briefings on this server");
		const found = await ctx.discover({ briefing, run: { _id: run._id, slot: run.slot, isManual: run.isManual, startedAt: run.startedAt }, env: ctx.env, fetchImpl: ctx.fetchImpl, now: ctx.now });
		for (const problem of (found?.errors ?? []).slice(0, 50)) {
			run.sourceErrors.push(typeof problem === "string" ? { sourceId: "", problem: problem.slice(0, 300) } : { sourceId: String(problem?.sourceId ?? problem?.foundBy ?? problem?.source ?? ""), problem: String(problem?.problem ?? problem?.message ?? "").slice(0, 300) });
		}
		const items = (await Promise.all((Array.isArray(found?.items) ? found.items : []).map(toItem))).filter(Boolean);
		const since = briefing.lastRunAt ?? new Date(new Date(run.startedAt).getTime() - DEDUPE.firstRunLookbackMs);
		const fresh = await dedupeItems({ items, seen: ctx.seen, since });
		run.counts.sources = new Set(items.map(({ foundBy }) => foundBy).filter(Boolean)).size;
		run.counts.fetched = items.length;
		run.counts.fresh = fresh.length;
		work.fresh = fresh;
		return fresh.length ? { next: "group" } : { finish: "no_news" };
	},

	async group(ctx) {
		const { work, account, now } = ctx;
		let vectors = null;
		if (typeof ctx.ai?.run === "function" && work.fresh.length > 1) {
			const taken = await takeAiRequest(account, now);
			if (taken.allowed) {
				try {
					vectors = await embedItems(ctx.ai, work.fresh);
				} catch {
					vectors = null;
					await returnAiRequest(account, now);
				}
			}
		}
		work.stories = groupItems(work.fresh, vectors);
		work.grouping = vectors ? "embeddings" : "words";
		ctx.run.counts.groups = work.stories.length;
		return { next: "triage" };
	},

	async triage(ctx) {
		const { run, briefing, work } = ctx;
		const { key, model } = await ctx.keyFor("triage");
		const scores = await scoreStories({ briefing, stories: work.stories, key, model, models: ctx.models });
		const maxStories = Math.min(MAX_STORIES, briefing.maxStories ?? DEFAULT_MAX_STORIES);
		const picked = pickStories(work.stories, scores, { minScore: briefing.minScore ?? DEFAULT_MIN_SCORE, maxStories });
		run.counts.picked = picked.length;
		run.stories = picked.map((story) => ({ externalId: `briefing:${briefing._id}:${story.key}`, title: story.title, url: story.url, score: story.score, sources: story.sources }));
		work.picked = picked;
		work.storyOf = Object.fromEntries(picked.flatMap((story) => story.items.map((item) => [item.urlHash, story.key])));
		delete work.stories;
		return picked.length ? { next: "extract" } : { finish: "no_news" };
	},

	// One story per pass, so a run cut off here keeps the records it has.
	async extract(ctx) {
		const { briefing, work } = ctx;
		work.records ??= [];
		work.resolved ??= {};
		const index = work.picked.findIndex((story) => !work.records.some((record) => record.storyKey === story.key));
		if (index === -1) return { next: "write" };
		const { key, model } = await ctx.keyFor("extract");
		const record = await extractStory({ briefing, story: work.picked[index], n: index + 1, fetcher: ctx.fetcher, key, model, models: ctx.models, resolved: work.resolved });
		work.records.push(record);
		work.records.sort((a, b) => a.n - b.n);
		return work.records.length === work.picked.length ? { next: "write" } : { partial: true };
	},

	async write(ctx) {
		const { key, model } = await ctx.keyFor("write");
		ctx.work.draft = await writeDraft({ briefing: ctx.briefing, records: ctx.work.records, key, model, models: ctx.models });
		return { next: "check" };
	},

	async check(ctx) {
		const { run, briefing, work } = ctx;
		const { draft, records } = work;
		const linkedMarkdown = linkCitations(draft.markdown, records);
		const checks = await codeChecks({ draft, linkedMarkdown, records, fetcher: ctx.fetcher, resolved: work.resolved ?? {} });
		const step = await ctx.keyFor("check");
		if (step.model === briefing.steps?.write?.model && String(briefing.steps?.check?.keyId) === String(briefing.steps?.write?.keyId)) {
			checks.push({ id: "check_model", status: "warning", message: "The check step uses the writer's own model, so the claim check was skipped" });
		} else {
			checks.push(...(await claimChecks({ draft, records, key: step.key, model: step.model, models: ctx.models })));
		}
		run.checks = checks;
		work.linkedMarkdown = linkedMarkdown;
		return { next: "deliver" };
	},

	async deliver(ctx) {
		const { run, briefing, work } = ctx;
		if (typeof ctx.delivery?.deliverIssue !== "function") throw new Error("No delivery is set up for briefings on this server");
		const result = await ctx.delivery.deliverIssue({
			accountId: String(run.accountId),
			newsletterId: String(run.newsletterId),
			briefingId: String(briefing._id),
			runId: String(run._id),
			slot: run.slot,
			subject: work.draft.subject,
			previewText: work.draft.previewText,
			markdown: work.linkedMarkdown,
			stories: storiesForDelivery({ briefingId: String(briefing._id), records: work.records, markdown: work.draft.markdown }),
			testEmail: briefing.testEmail ?? null,
			checks: run.checks,
			costUsd: ctx.meter.spent(),
		});
		return { finish: result?.status === "sent" ? "sent" : "drafted", campaignId: result?.campaignId };
	},
};

async function notifyNoNews(ctx) {
	if (typeof ctx.delivery?.notifyOwner !== "function") return;
	const { run, briefing } = ctx;
	const why = run.counts.fresh ? `${run.counts.fresh} new pages, none scoring ${briefing.minScore ?? DEFAULT_MIN_SCORE} or more for its audience` : "nothing new";
	try {
		await ctx.delivery.notifyOwner({
			accountId: String(run.accountId),
			briefingId: String(briefing._id),
			to: briefing.testEmail ?? null,
			subject: `No issue from ${briefing.name} this time`,
			text: `${briefing.name} found ${why}, so it made no draft.`,
		});
	} catch (error) {
		console.error(`[briefings] ${briefing._id}: the no news email failed: ${describe(error, ctx.secrets)}`);
	}
}

async function advanceRun(found, shared) {
	const { hasTime } = shared;
	// Every write moves touchedAt on by at least a millisecond: it is what the next write checks, so it has to change.
	const clock = () => new Date(Math.max(shared.clock().getTime(), new Date(run?.touchedAt ?? found.touchedAt ?? 0).getTime() + 1));
	let run = null;
	const lease = clock();
	const taken = await BriefingRun.updateOne({ accountId: found.accountId, _id: found._id, status: "running", touchedAt: found.touchedAt }, { $set: { touchedAt: lease } });
	if (!taken.modifiedCount) return { advanced: 0, finished: false };
	run = { ...found, touchedAt: lease, work: found.work ?? {}, calls: found.calls ?? [], checks: found.checks ?? [], stories: found.stories ?? [], sourceErrors: found.sourceErrors ?? [] };
	run.counts = { sources: 0, fetched: 0, fresh: 0, groups: 0, picked: 0, ...found.counts };
	const now = shared.now;
	const keys = new Map();
	const secrets = shared.secrets;
	let briefing = null;

	async function save(set = {}, unset) {
		const touchedAt = clock();
		run.work.fetches = ctx.fetcher.count;
		const update = {
			$set: { stage: run.stage, counts: run.counts, sourceErrors: run.sourceErrors, stories: run.stories, calls: run.calls, costUsd: ctx.meter.spent(), checks: run.checks, touchedAt, ...(unset ? {} : { work: run.work }), ...set },
			...(unset && { $unset: unset }),
		};
		const { modifiedCount } = await BriefingRun.updateOne({ accountId: run.accountId, _id: run._id, status: "running", touchedAt: run.touchedAt }, update);
		run.touchedAt = touchedAt;
		return modifiedCount > 0;
	}

	async function finish(status, { error, campaignId } = {}) {
		if (status === "no_news") await notifyNoNews(ctx);
		if (SUCCESS.has(status)) {
			await markSeen({ run, work: run.work, now: clock() });
			await Briefing.updateOne(scoped(run.accountId, { _id: run.briefingId }), { $set: { lastRunAt: new Date(run.startedAt) } });
		}
		run.stage = "done";
		await save({ status, finishedAt: clock(), ...(error && { error }), ...(campaignId && { campaignId }) }, { work: 1 });
		return { finished: true };
	}

	const ctx = {
		run,
		work: run.work,
		now,
		env: shared.env,
		fetchImpl: shared.fetchImpl,
		discover: shared.discover,
		ai: shared.ai,
		delivery: shared.delivery,
		hasTime,
		secrets,
		fetcher: createFetcher({ fetchImpl: shared.fetchImpl, used: run.work.fetches ?? 0 }),
		meter: createMeter({ budgetUsd: DEFAULT_BUDGET_USD, prices: [], calls: run.calls }),
		seen: async (hashes) => {
			const known = new Set();
			for (let start = 0; start < hashes.length; start += SEEN_BATCH) {
				const rows = await BriefingSeen.find(scoped(run.accountId, { briefingId: run.briefingId, urlHash: { $in: hashes.slice(start, start + SEEN_BATCH) } }))
					.select({ urlHash: 1 })
					.lean();
				for (const { urlHash } of rows) known.add(urlHash);
			}
			return known;
		},
		async keyFor(step) {
			const chosen = briefing.steps?.[step];
			if (!chosen?.keyId || !chosen?.model) throw new Error(`The ${step} step has no AI key or model chosen`);
			const id = String(chosen.keyId);
			if (!keys.has(id)) {
				const store = await shared.keyStore();
				const key = await store.getKey({ accountId: run.accountId, keyId: chosen.keyId });
				if (!key) throw new Error(`The ${step} step's AI key was removed`);
				const secret = String(key.secret ?? key.apiKey ?? "");
				if (secret) secrets.add(secret);
				keys.set(id, { ...key, keyId: id });
			}
			return { key: keys.get(id), model: chosen.model };
		},
		models: {
			text: async (args) => {
				const store = await shared.keyStore();
				const result = await callModel({ ...args, fetchImpl: shared.fetchImpl, meter: ctx.meter, endpoints: store.endpoints });
				await shared.noteKeyUsed(run.accountId, args.key.keyId);
				return result;
			},
			typesafe: async (args) => {
				const store = await shared.keyStore();
				const result = await callTypeSafe({ ...args, fetchImpl: shared.fetchImpl, meter: ctx.meter, endpoints: store.endpoints });
				await shared.noteKeyUsed(run.accountId, args.key.keyId);
				return result;
			},
		},
	};

	briefing = await Briefing.findOne(scoped(run.accountId, { _id: run.briefingId })).lean();
	if (!briefing) return finish("failed", { error: "The briefing was deleted while it ran" });
	const account = await Account.findById(run.accountId).lean();
	if (!account || isDeletionPending(account)) return finish("failed", { error: "The account is being deleted" });
	if (briefing.status !== "active" && !run.isManual) return finish("failed", { error: "The briefing was paused while it ran" });
	ctx.briefing = briefing;
	ctx.account = account;
	ctx.meter = createMeter({ budgetUsd: briefing.budgetUsd ?? DEFAULT_BUDGET_USD, prices: briefing.prices ?? [], calls: run.calls });

	let advanced = 0;
	while (hasTime()) {
		let result;
		try {
			result = await STAGES[run.stage](ctx);
		} catch (error) {
			if (error instanceof BudgetStop) return { advanced, ...(await finish("stopped_at_budget", { error: error.message })) };
			// Delivery is a call to another Worker: a failure there is tried again at the next tick, a few times.
			if (run.stage === "deliver" && (run.work.deliverAttempts ?? 0) + 1 < TICK.deliverAttempts) {
				run.work.deliverAttempts = (run.work.deliverAttempts ?? 0) + 1;
				await save({ error: describe(error, secrets) });
				return { advanced, finished: false };
			}
			console.error(`[briefings] run ${run._id} failed at ${run.stage}: ${describe(error, secrets)}`);
			return { advanced, ...(await finish("failed", { error: describe(error, secrets) })) };
		}
		advanced += 1;
		if (result.finish) return { advanced, ...(await finish(result.finish, result)) };
		if (result.next) run.stage = result.next;
		if (!(await save())) return { advanced, finished: false };
	}
	return { advanced, finished: false };
}

// One tick. discover({ briefing, run, env, fetchImpl, now }) -> { items: [{ url, title, snippet, publishedAt, publisher,
// foundBy }], errors } finds the candidate pages (its design is still open, so it is handed in). delivery: { deliverIssue,
// notifyOwner } (the API Worker's BriefingsDelivery, or lib/briefings-delivery.js in the app's own cron). getKey and markKeyUsed default to lib/ai-keys.js, the schedule to lib/briefing-schedule.js; endpoints
// (each provider's address) and nextRunAt may be handed in the same way. ai: the Workers AI binding, for grouping only.
export async function runTick({ env = process.env, now = new Date(), delivery, discover, timeBudgetMs = 300_000, fetchImpl = globalThis.fetch, ai, getKey, markKeyUsed, endpoints, nextRunAt } = {}) {
	const startedAt = Date.now();
	const clock = () => new Date(now.getTime() + (Date.now() - startedAt));
	const hasTime = () => Date.now() - startedAt < timeBudgetMs;
	await connectDb();

	let store = null;
	const keyStore = async () => {
		if (!store) {
			const needsDefaults = !getKey || !markKeyUsed || !endpoints;
			const defaults = needsDefaults ? await loadKeyStore() : {};
			store = { getKey: getKey ?? defaults.getKey, markKeyUsed: markKeyUsed ?? defaults.markKeyUsed, endpoints: endpoints ?? defaults.endpoints };
		}
		return store;
	};
	const marked = new Set();
	const shared = {
		now,
		env,
		discover,
		clock,
		hasTime,
		fetchImpl,
		delivery,
		ai: ai ?? env?.AI,
		keyStore,
		secrets: new Set(),
		async noteKeyUsed(accountId, keyId) {
			if (marked.has(keyId)) return;
			marked.add(keyId);
			try {
				await (await keyStore()).markKeyUsed?.({ accountId, keyId, at: clock() });
			} catch {
				// When a key was last used is a convenience for the dashboard, never a reason to stop a run.
			}
		},
	};

	const schedule = nextRunAt ?? nextBriefingRunAt;
	const started = [];
	const claimed = (await claimScheduled({ now, nextRunAt: schedule, started })) + (await claimManual({ now, started }));
	let finished = await failStale({ now });
	let advanced = 0;
	// A run another tick touched within its lease is that tick's: only older ones, and the ones this tick started, are taken.
	const leaseCutoff = new Date(now.getTime() - timeBudgetMs - TICK.leaseExtraMs);
	const resumed = await BriefingRun.find({ status: "running", touchedAt: { $lte: leaseCutoff } })
		.sort({ touchedAt: 1 })
		.limit(TICK.resumeLimit)
		.setOptions({ crossAccount: true })
		.lean();
	const fresh = started.length ? await BriefingRun.find({ _id: { $in: started }, status: "running" }).setOptions({ crossAccount: true }).lean() : [];
	for (const run of [...fresh, ...resumed]) {
		if (!hasTime()) break;
		const result = await advanceRun(run, shared);
		advanced += result.advanced;
		if (result.finished) finished += 1;
	}
	return { claimed, advanced, finished };
}
