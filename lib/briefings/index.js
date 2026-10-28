import { scoped } from "../account-scope.js";
import { isBlocked, isDeletionPending } from "../account-state.js";
import { countManualRunsToday, isOverManualRuns } from "../briefing-runs.js";
import { getBriefingSlot, nextBriefingRunAt } from "../briefing-schedule.js";
import { DEFAULT_BUDGET_USD, DEFAULT_MIN_SCORE } from "../briefing-rules.js";
import { connectDb } from "../db.js";
import { rawCollection } from "../docdb/index.js";
import Account from "../../models/Account.js";
import Briefing from "../../models/Briefing.js";
import BriefingRun from "../../models/BriefingRun.js";
import BriefingSeen from "../../models/BriefingSeen.js";
import { loadKeyStore, markKeyRejected as markRejected } from "./deps.js";
import { createFetcher } from "./fetch.js";
import { loadEarnedPublishers, loadPublishers, loadVerdicts, recordPublishers } from "./history.js";
import { BudgetStop, createMeter } from "./meter.js";
import { callModel, callTypeSafe, scrubSecret } from "./providers.js";
import { STAGES } from "./stages.js";
import { hostOf } from "./urls.js";

// The briefings engine (docs/BRIEFINGS-DESIGN.md, Where the engine runs and The run). A tick, every 10 minutes from the
// briefings Worker's Cron Trigger (or the hourly cron on a self-hosted server), claims the briefings that are due and the
// manual runs asked for, then moves each running run on stage by stage while its time lasts, saving after every stage, so a
// run cut off by the end of a tick goes on at the next. The unique (briefingId, slot) of BriefingRun is the lock that keeps a
// slot from running twice, as SeriesRun's is for series (lib/series.js).
export const TICK = { claimLimit: 25, resumeLimit: 20, staleMs: 60 * 60_000, runsPerAccountHour: 3, leaseExtraMs: 60_000, deliverAttempts: 3, maxRunMs: 6 * 60 * 60_000, claimPages: 5 };
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

// Due briefings are claimed by moving nextRunAt on in the same write that checks nobody else did, as runDueSeries does. An account
// at its hourly cap keeps its briefings due, but they are left out of the next page asked for, so a few busy accounts can't fill
// the queue and starve everyone else's.
async function claimScheduled({ now, nextRunAt, started }) {
	let claimed = 0;
	const capped = new Set();
	for (let page = 0; page < TICK.claimPages; page++) {
		const due = await Briefing.find({ status: "active", nextRunAt: { $lte: now }, ...(capped.size && { accountId: { $nin: [...capped] } }) })
			.sort({ nextRunAt: 1 })
			.limit(TICK.claimLimit)
			.setOptions({ crossAccount: true })
			.lean();
		let newlyCapped = false;
		for (const briefing of due) {
			const account = String(briefing.accountId);
			if (capped.has(account)) continue;
			if (await isOverHourlyCap(briefing.accountId, now)) {
				capped.add(account);
				newlyCapped = true;
				continue;
			}
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
		if (!newlyCapped || due.length < TICK.claimLimit) break;
	}
	return claimed;
}

async function claimManual({ now, started }) {
	let claimed = 0;
	const capped = new Set();
	for (let page = 0; page < TICK.claimPages; page++) {
		const asked = await Briefing.find({ manualRunAt: { $lte: now }, ...(capped.size && { accountId: { $nin: [...capped] } }) })
			.sort({ manualRunAt: 1 })
			.limit(TICK.claimLimit)
			.setOptions({ crossAccount: true })
			.lean();
		let newlyCapped = false;
		for (const briefing of asked) {
			const account = String(briefing.accountId);
			if (capped.has(account)) continue;
			if (await isOverHourlyCap(briefing.accountId, now)) {
				capped.add(account);
				newlyCapped = true;
				continue;
			}
			// A briefing has MANUAL_RUNS_PER_DAY manual runs a local day: one asked for past that is dropped, not kept waiting.
			const overDaily = isOverManualRuns(await countManualRunsToday(briefing, now));
			const { modifiedCount } = await Briefing.updateOne({ accountId: briefing.accountId, _id: briefing._id, manualRunAt: briefing.manualRunAt }, { $unset: { manualRunAt: 1 } });
			if (!modifiedCount || overDaily) continue;
			const run = await startRun({ briefing, slot: `manual:${new Date(briefing.manualRunAt).toISOString()}`, isManual: true, now });
			if (run) {
				started.push(run._id);
				claimed += 1;
			}
		}
		if (!newlyCapped || asked.length < TICK.claimLimit) break;
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
	const hashes = work.seenHashes ?? (work.fresh ?? []).map(({ urlHash }) => urlHash);
	const rows = [...new Set(hashes)].map((urlHash) => ({ accountId: run.accountId, briefingId: run.briefingId, urlHash, ...(storyOf[urlHash] && { storyKey: storyOf[urlHash] }), firstSeenAt: now }));
	for (let start = 0; start < rows.length; start += SEEN_BATCH) await BriefingSeen.insertMany(rows.slice(start, start + SEEN_BATCH), { ordered: false });
}

// What the run saw of each publisher, for BriefingPublisher: seen, shortlisted and picked, and the feeds autodiscovery found.
async function markPublishers({ run, work, now }) {
	const counts = {};
	const add = (host, field, by = 1) => {
		if (!host) return;
		counts[host] ??= {};
		counts[host][field] = (counts[host][field] ?? 0) + by;
	};
	const seen = work.seenHosts ?? (work.fresh ?? []).reduce((all, { url }) => ({ ...all, [hostOf(url)]: (all[hostOf(url)] ?? 0) + 1 }), {});
	for (const [host, count] of Object.entries(seen)) add(host, "seen", count);
	for (const host of work.shortlistHosts ?? []) add(host, "shortlisted");
	for (const host of work.pickedHosts ?? []) add(host, "picked");
	await recordPublishers({ accountId: run.accountId, briefingId: run.briefingId, counts, feeds: work.publisherFeeds ?? {}, now });
}

async function notifyOwner(ctx, { subject, text }) {
	if (typeof ctx.delivery?.notifyOwner !== "function") return;
	try {
		await ctx.delivery.notifyOwner({ accountId: String(ctx.run.accountId), briefingId: String(ctx.run.briefingId), to: ctx.briefing?.testEmail ?? null, subject, text });
	} catch (error) {
		console.error(`[briefings] ${ctx.run.briefingId}: an email to the owner failed: ${describe(error, ctx.secrets)}`);
	}
}

function noNewsText(ctx) {
	const { run, briefing } = ctx;
	const why = run.counts.fresh ? `${run.counts.fresh} new pages, none scoring ${briefing.minScore ?? DEFAULT_MIN_SCORE} or more for its audience` : "nothing new";
	return `${briefing.name} found ${why}, so it made no draft.`;
}

async function advanceRun(found, shared) {
	const { hasTime } = shared;
	// Every write moves touchedAt on by at least a millisecond: it is what the next write checks, so it has to change.
	const clock = () => new Date(Math.max(shared.clock().getTime(), new Date(run?.touchedAt ?? found.touchedAt ?? 0).getTime() + 1));
	let run = null;
	const lease = clock();
	const taken = await BriefingRun.updateOne({ accountId: found.accountId, _id: found._id, status: "running", touchedAt: found.touchedAt }, { $set: { touchedAt: lease } });
	if (!taken.modifiedCount) return { advanced: 0, finished: false };
	run = { ...found, touchedAt: lease, work: found.work ?? {}, calls: found.calls ?? [], checks: found.checks ?? [], stories: found.stories ?? [], discoveryNotes: found.discoveryNotes ?? [], queries: found.queries ?? [], languages: found.languages ?? [] };
	run.counts = { queries: 0, results: 0, candidates: 0, fresh: 0, groups: 0, shortlisted: 0, picked: 0, ...found.counts };
	const now = shared.now;
	const keys = new Map();
	const secrets = shared.secrets;
	let briefing = null;
	let history = null;

	async function save(set = {}, unset) {
		const touchedAt = clock();
		run.work.fetches = ctx.fetcher.count;
		const fields = { stage: run.stage, counts: run.counts, queries: run.queries, discoveryNotes: run.discoveryNotes, stories: run.stories, calls: run.calls, costUsd: ctx.meter.spent(), checks: run.checks, languages: run.languages, thin: Boolean(run.thin), touchedAt };
		if (run.heldReason) fields.heldReason = run.heldReason;
		const update = { $set: { ...fields, ...(unset ? {} : { work: run.work }), ...set }, ...(unset && { $unset: unset }) };
		// The last line of defence: a decrypted key never reaches the database, whatever a stage put in the run.
		const stored = JSON.stringify(update.$set);
		for (const secret of secrets) if (secret.length >= 8 && stored.includes(secret)) throw new Error("A key was about to be saved with the run; the run was stopped instead");
		const { modifiedCount } = await BriefingRun.updateOne({ accountId: run.accountId, _id: run._id, status: "running", touchedAt: run.touchedAt }, update);
		run.touchedAt = touchedAt;
		return modifiedCount > 0;
	}

	async function finish(status, { error, campaignId } = {}) {
		if (status === "no_news") await notifyOwner(ctx, { subject: `No issue from ${ctx.briefing.name} this time`, text: noNewsText(ctx) });
		if (SUCCESS.has(status)) {
			await markSeen({ run, work: run.work, now: clock() });
			await markPublishers({ run, work: run.work, now: clock() });
			await Briefing.updateOne(scoped(run.accountId, { _id: run.briefingId }), { $set: { lastRunAt: new Date(run.startedAt) } });
		}
		if (status === "stopped_at_budget" || status === "failed") run.heldReason = undefined;
		run.stage = "done";
		await save({ status, finishedAt: clock(), ...(error && { error }), ...(campaignId && { campaignId }) }, { work: 1 });
		return { finished: true };
	}

	async function loadKey(keyId, label) {
		const id = String(keyId);
		if (!keys.has(id)) {
			const store = await shared.keyStore();
			const key = await store.getKey({ accountId: run.accountId, keyId });
			if (!key) throw new Error(`The ${label} AI key was removed`);
			const secret = String(key.secret ?? key.apiKey ?? "");
			if (secret) secrets.add(secret);
			keys.set(id, { ...key, keyId: id });
		}
		return keys.get(id);
	}

	const ctx = {
		run,
		work: run.work,
		now,
		clock,
		env: shared.env,
		fetchImpl: shared.fetchImpl,
		discover: shared.discover,
		ai: shared.ai,
		delivery: shared.delivery,
		hasTime,
		canWait: (ms) => shared.timeLeft() > ms + 5000,
		sleep: shared.sleep,
		secrets,
		describe: (error) => describe(error, secrets),
		fetcher: createFetcher({ fetchImpl: shared.fetchImpl, resolveHost: shared.resolveHost, used: run.work.fetches ?? 0 }),
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
		history: async () => (history ??= await loadVerdicts({ accountId: run.accountId, briefingId: run.briefingId })),
		publishers: (hosts) => loadPublishers({ accountId: run.accountId, briefingId: run.briefingId, hosts }),
		// The trusted outlets and the publishers that earned a score, with the feed each is known to have (undefined: not looked for).
		async outletsToRead() {
			const trusted = (briefing.trustedOutlets ?? []).map((host) => String(host).toLowerCase().replace(/^www\./, ""));
			const known = await loadPublishers({ accountId: run.accountId, briefingId: run.briefingId, hosts: trusted });
			const earned = await loadEarnedPublishers({ accountId: run.accountId, briefingId: run.briefingId });
			const outlets = new Map(trusted.map((host) => [host, { host, feedUrl: known.get(host)?.feedUrl }]));
			// "" is a home page already read and found without a feed.
			for (const row of earned) if (!outlets.has(row.host) && row.feedUrl !== "") outlets.set(row.host, { host: row.host, feedUrl: row.feedUrl ?? undefined });
			return [...outlets.values()].filter(({ host }) => !ctx.fetcher.isBlocked(`https://${host}/`));
		},
		async keyFor(step) {
			const chosen = briefing.steps?.[step];
			if (!chosen?.keyId || !chosen?.model) throw new Error(`The ${step} step has no AI key or model chosen`);
			return { key: await loadKey(chosen.keyId, `${step} step's`), model: chosen.model };
		},
		searchKey: (keyId) => loadKey(keyId, "search"),
		// A search key the provider refused: marked rejected, one email to the owner, and the run goes on without it.
		async keyRejected({ keyId, provider }) {
			try {
				await shared.markKeyRejected({ accountId: run.accountId, keyId, at: clock() });
			} catch (error) {
				console.error(`[briefings] could not mark a key rejected: ${describe(error, secrets)}`);
			}
			await notifyOwner(ctx, { subject: `${provider} refused your key`, text: `${provider} refused the key ${briefing.name} searches with, so this run went on without it. Check the key in your AI keys.` });
		},
		models: {
			text: async (args) => {
				const store = await shared.keyStore();
				const result = await callModel({ ...args, fetchImpl: shared.fetchImpl, meter: ctx.meter, endpoints: store.endpoints, guard: ctx.fetcher.assertPublic });
				await shared.noteKeyUsed(run.accountId, args.key.keyId);
				return result;
			},
			typesafe: async (args) => {
				const store = await shared.keyStore();
				const result = await callTypeSafe({ ...args, fetchImpl: shared.fetchImpl, meter: ctx.meter, endpoints: store.endpoints, guard: ctx.fetcher.assertPublic });
				await shared.noteKeyUsed(run.accountId, args.key.keyId);
				return result;
			},
		},
	};

	briefing = await Briefing.findOne(scoped(run.accountId, { _id: run.briefingId })).lean();
	if (!briefing) return finish("failed", { error: "The briefing was deleted while it ran" });
	ctx.briefing = briefing;
	// The same gates as runAction (lib/actions/run-action.js): nothing runs, and no model is paid for, for an account that is
	// being deleted or is blocked, or for a briefing whose newsletter is gone.
	const account = await Account.findById(run.accountId).lean();
	if (!account || isDeletionPending(account)) return finish("failed", { error: "The account is being deleted" });
	if (isBlocked(account)) return finish("failed", { error: "The account is blocked, so the briefing didn't run" });
	// Read raw: the Newsletter model (its schema, brand and navigation rules) would cost the Worker 7.5 KB for one existence check.
	const newsletter = await rawCollection("newsletters").findOne({ _id: String(run.newsletterId), accountId: String(account._id) }, { projection: { _id: 1 } });
	if (!newsletter) return finish("failed", { error: "The briefing's newsletter is gone" });
	if (briefing.status !== "active" && !run.isManual) return finish("failed", { error: "The briefing was paused while it ran" });
	ctx.account = account;
	ctx.fetcher = createFetcher({ fetchImpl: shared.fetchImpl, resolveHost: shared.resolveHost, blockedHosts: briefing.blockedHosts ?? [], used: run.work.fetches ?? 0 });
	ctx.meter = createMeter({ budgetUsd: briefing.budgetUsd ?? DEFAULT_BUDGET_USD, stepBudgets: briefing.stepBudgets, prices: briefing.prices ?? [], calls: run.calls });

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
		let saved;
		try {
			saved = await save();
		} catch (error) {
			return { advanced, ...(await finish("failed", { error: describe(error, secrets) })) };
		}
		if (!saved) return { advanced, finished: false };
		if (result.yield) return { advanced, finished: false };
	}
	return { advanced, finished: false };
}

// One tick. delivery: { deliverIssue, notifyOwner } (the API Worker's BriefingsDelivery, or lib/briefings-delivery.js in the app's
// own cron). Discovery is the engine's own (lib/briefings/discovery/) unless `discover({ briefing, run, env, fetchImpl, now })
// -> { items: [{ url, title, snippet, publishedAt, publisher, foundBy }], errors }` is handed in. getKey, markKeyUsed and
// markKeyRejected default to lib/ai-keys.js and the engine's own, the schedule to lib/briefing-schedule.js; endpoints (each
// provider's address), nextRunAt, resolveHost (a hostname's addresses) and sleep may be handed in the same way. ai: the Workers
// AI binding, for clustering only.
export async function runTick({ env = process.env, now = new Date(), delivery, discover, timeBudgetMs = 300_000, fetchImpl = globalThis.fetch, ai, getKey, markKeyUsed, markKeyRejected, endpoints, nextRunAt, resolveHost, sleep } = {}) {
	const startedAt = Date.now();
	const clock = () => new Date(now.getTime() + (Date.now() - startedAt));
	const hasTime = () => Date.now() - startedAt < timeBudgetMs;
	const timeLeft = () => timeBudgetMs - (Date.now() - startedAt);
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
		timeLeft,
		sleep: sleep ?? ((ms) => new Promise((wake) => setTimeout(wake, ms))),
		resolveHost,
		markKeyRejected: markKeyRejected ?? markRejected,
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
