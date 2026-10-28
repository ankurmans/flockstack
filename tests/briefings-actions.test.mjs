import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, describe, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { as, callApi, withEnv } from "./helpers/app.mjs";
import { setupAudienceTests } from "./helpers/audience.mjs";

// Briefings' actions (docs/BRIEFINGS-DESIGN.md, Actions): sources, schedule, steps on the account's own AI keys, runs asked for
// and read back, over REST and the dashboard's server actions. The engine itself is tests/briefings-engine*.

const SECRET = "sk-MADEUP-briefings-0123456789SECRET";
const FEED = "https://news.example.com/feed.xml";
const AT = (text) => new Date(text);

let t;
let m;

async function addKey(user, provider, key = `${SECRET}-${provider}`) {
	const response = await t.api(user.key, "POST", "/ai-keys", { name: `${provider} key`, provider, key });
	assert.equal(response.status, 201, JSON.stringify(response.body));
	return response.body;
}

function allSteps(writer, checker, { writeModel = "gpt-4.1-mini", checkModel = "gpt-4.1-nano" } = {}) {
	return {
		triage: { keyId: writer.id, model: writeModel },
		extract: { keyId: writer.id, model: writeModel },
		write: { keyId: writer.id, model: writeModel },
		check: { keyId: checker.id, model: checkModel },
	};
}

before(async () => {
	t = await setupAudienceTests({ CREDENTIALS_ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64") });
	m = {
		...t.m,
		schedule: await import("../lib/briefing-schedule.js"),
		scopes: await import("../lib/action-scopes.js"),
		actions: await import("../app/(app)/briefings/actions.js"),
		list: await import("../app/(app)/briefings/page.js"),
		create: await import("../app/(app)/briefings/new/page.js"),
		detail: await import("../app/(app)/briefings/[id]/page.js"),
		Briefing: (await import("../models/Briefing.js")).default,
		BriefingRun: (await import("../models/BriefingRun.js")).default,
		BriefingSeen: (await import("../models/BriefingSeen.js")).default,
		TeamSeat: (await import("../models/TeamSeat.js")).default,
	};
});

after(() => t?.app.stop());

describe("the schedule", () => {
	test("the next run is the time in its zone on a weekday it runs (1 Monday to 7 Sunday), daylight saving included", () => {
		const weekdays = { days: [1, 2, 3, 4, 5], time: "06:00", timeZone: "Europe/Paris" };
		let at = AT("2026-10-22T10:00:00Z");
		const runs = [];
		for (let index = 0; index < 4; index++) runs.push((at = m.schedule.nextBriefingRunAt(weekdays, at)).toISOString());
		// Thursday, Friday, then Monday after the clocks go back on Sunday the 25th.
		assert.deepEqual(runs, ["2026-10-23T04:00:00.000Z", "2026-10-26T05:00:00.000Z", "2026-10-27T05:00:00.000Z", "2026-10-28T05:00:00.000Z"]);
		assert.equal(m.schedule.nextBriefingRunAt({ days: [7], time: "23:30", timeZone: "America/New_York" }, AT("2026-10-25T12:00:00Z")).toISOString(), "2026-10-26T03:30:00.000Z");
		assert.equal(m.schedule.nextBriefingRunAt({ days: [3], time: "06:00", timeZone: "UTC" }, AT("2026-10-28T06:00:00Z")).toISOString(), "2026-11-04T06:00:00.000Z", "a run due now is not the next one");
		assert.equal(m.schedule.nextBriefingRunAt({ days: [], time: "06:00", timeZone: "UTC" }), null);
		assert.equal(m.schedule.getBriefingSlot({ timeZone: "Asia/Tokyo" }, AT("2026-10-27T22:00:00Z")), "2026-10-28");
		assert.equal(m.schedule.describeBriefingSchedule(weekdays), "Weekdays at 06:00 (Europe/Paris)");
		assert.equal(m.schedule.describeBriefingSchedule({ days: [4, 1], time: "07:15", timeZone: "UTC" }), "Mondays and Thursdays at 07:15 (UTC)");
		assert.equal(m.schedule.describeBriefingSchedule({ days: [1, 2, 3, 4, 5, 6, 7], time: "07:15", timeZone: "UTC" }), "Every day at 07:15 (UTC)");
		for (const [schedule, pattern] of [
			[{ days: [0], time: "06:00" }, /days of the week/],
			[{ days: [8], time: "06:00" }, /days of the week/],
			[{ days: [1], time: "24:00" }, /HH:MM/],
			[{ days: [1], time: "06:00", timeZone: "Mars/Olympus" }, /time zone/],
		]) assert.match(m.schedule.getBriefingScheduleProblem(schedule), pattern);
	});
});

describe("managing a briefing", () => {
	let user;
	let openai;
	let groq;

	before(async () => {
		user = await t.customer("briefings-manage@example.com");
		openai = await addKey(user, "openai");
		groq = await addKey(user, "groq");
	});

	test("created paused with the defaults, a stable id per source and the owner as test email", async () => {
		const created = await t.api(user.key, "POST", "/briefings", {
			name: "Morning briefing",
			sources: [{ kind: "feed", url: FEED, label: "News" }, { kind: "page", url: "https://blog.example.com/" }],
			schedule: { days: [5, 1, 1], timeZone: "europe/paris" },
		});
		assert.equal(created.status, 201, JSON.stringify(created.body));
		const briefing = created.body;
		assert.deepEqual([briefing.status, briefing.nextRunAt, briefing.reviewMode, briefing.maxStories, briefing.minScore, briefing.budgetUsd], ["paused", null, "draft", 6, 60, 0.25]);
		assert.deepEqual(briefing.schedule, { days: [1, 5], time: "06:00", timeZone: "Europe/Paris" });
		assert.deepEqual(briefing.languages, ["en"]);
		assert.equal(briefing.testEmail, "briefings-manage@example.com");
		assert.deepEqual(briefing.steps, { triage: null, extract: null, write: null, check: null });
		assert.equal(briefing.sources.length, 2);
		for (const source of briefing.sources) assert.match(source.id, /^src_[a-f0-9]{10}$/);

		const again = await t.api(user.key, "PATCH", `/briefings/${briefing.id}`, { sources: [{ kind: "page", url: "https://blog.example.com/" }, { kind: "url", url: "https://example.com/pricing", id: "pricing" }] });
		assert.equal(again.body.sources[0].id, briefing.sources[1].id, "an address keeps its id");
		assert.equal(again.body.sources[1].id, "pricing");

		t.assertError(await t.api(user.key, "POST", "/briefings", { name: "Second" }), 409, "conflict");
		const other = await t.customer("briefings-other@example.com");
		assert.deepEqual((await t.api(other.key, "GET", "/briefings")).body.briefings, []);
		t.assertError(await t.api(other.key, "GET", `/briefings/${briefing.id}`), 404, "not_found");
		t.assertError(await t.api(other.key, "POST", `/briefings/${briefing.id}/pause`), 404, "not_found");
		t.assertError(await t.api(other.key, "GET", `/briefings/${briefing.id}/runs`), 404, "not_found");
	});

	test("refuses what the rules don't allow, saying why", async () => {
		const [briefing] = (await t.api(user.key, "GET", "/briefings")).body.briefings;
		const other = await t.customer("briefings-foreign@example.com");
		const foreign = await addKey(other, "openai");
		const typesafe = await addKey(user, "typesafe");
		const refusals = [
			[{ sources: [{ kind: "feed", url: "http://news.example.com/feed" }] }, /Source 1: .*https/],
			[{ sources: [{ kind: "feed", url: "https://192.168.1.4/feed" }] }, /Source 1: .*private network/],
			[{ sources: [{ kind: "feed", url: FEED }, { kind: "page", url: FEED }] }, /Source 2: .*already/],
			[{ sources: Array.from({ length: 101 }, (_, index) => ({ kind: "feed", url: `https://news.example.com/${index}` })) }, /sources/],
			[{ sources: [{ kind: "rss", url: FEED }] }, /kind/],
			[{ schedule: { days: [0] } }, /days/],
			[{ schedule: { time: "6am" } }, /time/],
			[{ schedule: { timeZone: "Mars/Olympus" } }, /time zone/],
			[{ languages: ["xx"] }, /languages/],
			[{ languages: [] }, /languages/],
			[{ maxStories: 16 }, /maxStories/],
			[{ minScore: 101 }, /minScore/],
			[{ budgetUsd: 0 }, /budgetUsd/],
			[{ budgetUsd: 20.01 }, /budgetUsd/],
			[{ audience: "a".repeat(2001) }, /audience/],
			[{ styleGuide: "a".repeat(8001) }, /styleGuide/],
			[{ reviewMode: "send_if_checks_pass" }, /isn't available yet/],
			[{ testEmail: "stranger@example.org" }, /team/],
			[{ steps: { triage: { keyId: foreign.id, model: "gpt-4.1-mini" } } }, /isn't one of this account's/],
			[{ steps: { write: { keyId: typesafe.id, model: "jev-latest" } } }, /TypeSafe key can score stories and check claims, not write/],
			[{ steps: { extract: { keyId: typesafe.id, model: "jev-latest" } } }, /not extract/],
			[{ steps: { write: { keyId: openai.id, model: "gpt-4.1" }, check: { keyId: openai.id, model: "GPT-4.1" } } }, /another model than the write step/],
			[{ status: "active" }, /all four steps/],
		];
		for (const [body, pattern] of refusals) {
			const response = await t.api(user.key, "PATCH", `/briefings/${briefing.id}`, body);
			assert.match(t.assertError(response, 400, "validation_failed"), pattern, JSON.stringify(body).slice(0, 80));
		}
		const sameModelOtherProvider = await t.api(user.key, "PATCH", `/briefings/${briefing.id}`, { steps: { write: { keyId: openai.id, model: "llama-3.3-70b" }, check: { keyId: groq.id, model: "llama-3.3-70b" } } });
		assert.equal(sameModelOtherProvider.status, 200, "the same name at another provider is another model");
		const typesafeCheck = await t.api(user.key, "PATCH", `/briefings/${briefing.id}`, { steps: { triage: { keyId: typesafe.id, model: "jev-latest" }, check: { keyId: typesafe.id, model: "jev-latest" } } });
		assert.equal(typesafeCheck.status, 200, JSON.stringify(typesafeCheck.body));
		await m.TeamSeat.create({ accountId: user.accountId, email: "editor@briefings-manage.example.com", role: "editor", status: "active" });
		assert.equal((await t.api(user.key, "PATCH", `/briefings/${briefing.id}`, { testEmail: "Editor@briefings-manage.example.com" })).body.testEmail, "editor@briefings-manage.example.com");
		await t.api(user.key, "PATCH", `/briefings/${briefing.id}`, { steps: { triage: null, extract: null, write: null, check: null } });
	});

	test("turned on with all four steps it has a next run; paused it has none; resumed it has one again; the steps show keys by name", async () => {
		const [briefing] = (await t.api(user.key, "GET", "/briefings")).body.briefings;
		const on = await t.api(user.key, "PATCH", `/briefings/${briefing.id}`, { steps: allSteps(openai, groq, { checkModel: "llama-3.3-70b" }), status: "active", schedule: { days: [1, 2, 3, 4, 5, 6, 7], time: "07:30", timeZone: "UTC" } });
		assert.equal(on.status, 200, JSON.stringify(on.body));
		assert.equal(on.body.status, "active");
		const next = new Date(on.body.nextRunAt);
		assert.ok(next > new Date() && next - Date.now() <= 86_400_000);
		assert.equal(next.toISOString().slice(11, 16), "07:30");
		assert.deepEqual(on.body.steps.write, { keyId: openai.id, keyName: "openai key", keyHint: openai.hint, provider: "openai", model: "gpt-4.1-mini" });
		assert.ok(!JSON.stringify(on.body).includes(SECRET));
		assert.ok(!JSON.stringify((await t.api(user.key, "GET", `/briefings/${briefing.id}`)).body).includes(SECRET));

		const paused = await t.api(user.key, "POST", `/briefings/${briefing.id}/pause`);
		assert.deepEqual([paused.body.status, paused.body.nextRunAt], ["paused", null]);
		const resumed = await t.api(user.key, "POST", `/briefings/${briefing.id}/resume`);
		assert.equal(resumed.body.status, "active");
		assert.ok(new Date(resumed.body.nextRunAt) > new Date());
		const moved = await t.api(user.key, "PATCH", `/briefings/${briefing.id}`, { schedule: { time: "05:00" } });
		assert.equal(new Date(moved.body.nextRunAt).toISOString().slice(11, 16), "05:00");

		const used = await t.api(user.key, "DELETE", `/ai-keys/${openai.id}`);
		assert.match(t.assertError(used, 409, "conflict"), /A briefing uses this key/);
		assert.equal((await t.api(user.key, "GET", "/ai-keys")).body.keys.find(({ id }) => id === openai.id).usedBy, 1);
	});

	test("run_briefing answers unavailable where the engine doesn't run, and queues a manual run where it does", async () => {
		const [briefing] = (await t.api(user.key, "GET", "/briefings")).body.briefings;
		await withEnv({ BRIEFINGS_ENABLED: "", BRIEFINGS_IN_CRON: "" }, async () => {
			assert.match(t.assertError(await t.api(user.key, "POST", `/briefings/${briefing.id}/run`), 503, "unavailable"), /briefings/i);
		});
		await withEnv({ BRIEFINGS_ENABLED: "true" }, async () => {
			const queued = await t.api(user.key, "POST", `/briefings/${briefing.id}/run`);
			assert.equal(queued.status, 200, JSON.stringify(queued.body));
			assert.ok(Date.now() - new Date(queued.body.manualRunAt) < 60_000);
		});
		await withEnv({ BRIEFINGS_IN_CRON: "true" }, async () => {
			const bare = await t.api(user.key, "POST", "/briefings", { newsletter: (await m.Newsletter.create({ accountId: user.accountId, name: "Second", slug: "briefings-second", fromName: "x", fromEmail: "x@briefings-second.flockstackmail.com" }))._id.toString(), name: "Bare" });
			assert.equal(bare.status, 201, JSON.stringify(bare.body));
			assert.match(t.assertError(await t.api(user.key, "POST", `/briefings/${bare.body.id}/run`), 400, "validation_failed"), /all four steps|source/);
		});
	});

	test("runs are listed newest first and read one by one, never with their working data", async () => {
		const [briefing] = (await t.api(user.key, "GET", "/briefings")).body.briefings;
		const base = { accountId: user.accountId, briefingId: briefing.id, newsletterId: briefing.newsletterId };
		const older = await m.BriefingRun.create({ ...base, slot: "2026-10-26", stage: "done", status: "no_news", startedAt: AT("2026-10-26T05:00:00Z"), createdAt: AT("2026-10-26T05:00:00Z"), work: { items: ["WORKING_DATA"] } });
		const newer = await m.BriefingRun.create({
			...base,
			slot: "2026-10-27",
			stage: "done",
			status: "drafted",
			counts: { sources: 2, fetched: 40, fresh: 12, groups: 8, picked: 3 },
			stories: [{ externalId: "briefing:x:1", title: "A story", url: "https://news.example.com/a", score: 82, sources: ["src_1"] }],
			calls: [{ step: "write", provider: "openai", model: "gpt-4.1-mini", inputTokens: 9000, outputTokens: 800, costUsd: 0.0049, costFrom: "price_table" }],
			costUsd: 0.0049,
			checks: [{ id: "numbers", status: "pass", message: "Every number is in its source" }, { id: "length", status: "warning", message: "A little long" }],
			startedAt: AT("2026-10-27T05:00:00Z"),
			createdAt: AT("2026-10-27T05:00:00Z"),
			work: { draft: "WORKING_DATA" },
		});
		const listed = await t.api(user.key, "GET", `/briefings/${briefing.id}/runs`);
		assert.deepEqual(listed.body.runs.map(({ id }) => id), [String(newer._id), String(older._id)]);
		assert.deepEqual((await t.api(user.key, "GET", `/briefings/${briefing.id}/runs?limit=1`)).body.runs.map(({ id }) => id), [String(newer._id)]);
		const one = await t.api(user.key, "GET", `/briefing-runs/${newer._id}`);
		assert.deepEqual([one.body.status, one.body.counts.picked, one.body.costUsd, one.body.checks.length], ["drafted", 3, 0.0049, 2]);
		for (const body of [listed.body, one.body, (await t.api(user.key, "GET", `/briefings/${briefing.id}`)).body]) {
			assert.ok(!JSON.stringify(body).includes("WORKING_DATA"));
			assert.ok(!JSON.stringify(body).includes('"work"'));
		}
		assert.equal((await t.api(user.key, "GET", `/briefings/${briefing.id}`)).body.lastRun.id, String(newer._id));
		const other = await t.customer("briefings-runs-other@example.com");
		t.assertError(await t.api(other.key, "GET", `/briefing-runs/${newer._id}`), 404, "not_found");
	});

	test("deleting a briefing takes its runs and memory with it, and frees its keys", async () => {
		const [briefing] = (await t.api(user.key, "GET", "/briefings")).body.briefings;
		await m.BriefingSeen.create({ accountId: user.accountId, briefingId: briefing.id, urlHash: "a".repeat(64), firstSeenAt: new Date() });
		assert.deepEqual((await t.api(user.key, "DELETE", `/briefings/${briefing.id}`)).body, { id: briefing.id, deleted: true });
		assert.equal(await m.BriefingRun.countDocuments({ accountId: user.accountId, briefingId: briefing.id }), 0);
		assert.equal(await m.BriefingSeen.countDocuments({ accountId: user.accountId, briefingId: briefing.id }), 0);
		assert.equal((await t.api(user.key, "DELETE", `/ai-keys/${openai.id}`)).status, 200);
	});
});

describe("agents", () => {
	test("each action has its class: reads, settings, deletes and keys", async () => {
		const classes = Object.fromEntries(
			["list_briefings", "get_briefing", "create_briefing", "update_briefing", "pause_briefing", "resume_briefing", "delete_briefing", "run_briefing", "list_briefing_runs", "get_briefing_run", "add_ai_key", "list_ai_keys", "check_ai_key", "delete_ai_key"].map((name) => [name, m.scopes.getActionClass(name, {})])
		);
		assert.deepEqual(classes, {
			list_briefings: "read",
			get_briefing: "read",
			create_briefing: "write",
			update_briefing: "write",
			pause_briefing: "write",
			resume_briefing: "write",
			delete_briefing: "destructive",
			run_briefing: "write",
			list_briefing_runs: "read",
			get_briefing_run: "read",
			add_ai_key: "admin",
			list_ai_keys: "read",
			check_ai_key: "admin",
			delete_ai_key: "destructive",
		});
		assert.equal(m.scopes.getActionClass("create_briefing", { reviewMode: "send_if_checks_pass" }), "send");
		assert.equal(m.scopes.getActionClass("update_briefing", { reviewMode: "send_if_checks_pass" }), "send");
		assert.equal(m.scopes.isGateable("create_briefing"), true);
		assert.equal(m.scopes.getTargetOf("get_briefing_run").model, "BriefingRun");

		const user = await t.customer("briefings-agents@example.com");
		const drafts = await t.createKey(user, "drafts");
		const readOnly = await t.createKey(user, "read_only");
		t.assertError(await t.api(drafts, "POST", "/briefings", { name: "From a drafts key" }), 403, "forbidden");
		assert.equal((await t.api(readOnly, "GET", "/briefings")).status, 200);
		const careful = await t.createKey(user, "send_with_approval");
		const created = await t.api(careful, "POST", "/briefings", { name: "From a careful key" });
		assert.equal(created.status, 201, "write runs at once");
		const deletion = await callApi("DELETE", `/api/v1/briefings/${created.body.id}`, { key: careful });
		assert.equal(deletion.status, 202, "a delete waits for the owner");
		assert.equal(deletion.body.status, "approval_required");
	});

	test("account purge deletes the four collections", async () => {
		const { CONTENT_MODELS } = await import("../lib/account-purge.js");
		for (const model of [m.Briefing, m.BriefingRun, m.BriefingSeen, (await import("../models/AiProviderKey.js")).default]) assert.ok(CONTENT_MODELS.includes(model), model.modelName);
	});
});

describe("the dashboard", () => {
	test("makes, saves, runs and deletes a briefing through the server actions, and the pages show it with its runs", async () => {
		const user = await t.customer("briefings-dashboard@example.com");
		const writer = await addKey(user, "openrouter");
		const checker = await addKey(user, "typesafe");
		const values = {
			name: "Dashboard briefing",
			sources: [{ kind: "feed", url: FEED, label: "" }, { kind: "feed", url: "  ", label: "" }],
			days: [1, 3],
			time: "06:30",
			timeZone: "UTC",
			audience: "Founders",
			styleGuide: "Short",
			languages: ["en", "fr"],
			maxStories: "5",
			minScore: "70",
			budgetUsd: "0.5",
			steps: { triage: { keyId: checker.id, model: "jev-latest" }, extract: { keyId: writer.id, model: "qwen/qwen3-30b" }, write: { keyId: writer.id, model: "qwen/qwen3-30b" }, check: { keyId: checker.id, model: "jev-latest" } },
			testEmail: "briefings-dashboard@example.com",
			active: true,
		};
		const bad = await as(user, () => m.actions.createBriefing(user.newsletterId, { ...values, sources: [{ kind: "feed", url: "http://example.com/feed" }] }));
		assert.match(bad.error, /https/);
		const created = await as(user, () => m.actions.createBriefing(user.newsletterId, values));
		assert.equal(created.ok, true, JSON.stringify(created));
		const stored = await m.Briefing.findOne({ accountId: user.accountId, _id: created.id }).lean();
		assert.deepEqual([stored.status, stored.maxStories, stored.minScore, stored.budgetUsd, stored.sources.length, stored.languages], ["active", 5, 70, 0.5, 1, ["en", "fr"]]);

		const listed = renderToStaticMarkup(await as(user, () => m.list.default()));
		assert.match(listed, /Dashboard briefing/);
		assert.match(listed, /Mondays and Wednesdays at 06:30 \(UTC\), 1 source/);
		assert.match(listed, /None yet/);
		assert.match(renderToStaticMarkup(await as(user, () => m.create.default())), /qwen|openrouter key/i);

		assert.equal((await as(user, () => m.actions.updateBriefing(created.id, { ...values, active: false }))).ok, true);
		assert.equal((await m.Briefing.findOne({ accountId: user.accountId, _id: created.id }).lean()).status, "paused");
		const unavailable = await withEnv({ BRIEFINGS_ENABLED: "", BRIEFINGS_IN_CRON: "" }, () => as(user, () => m.actions.runBriefingNow(created.id)));
		assert.match(unavailable.error, /don't run on this server/);
		assert.deepEqual(await withEnv({ BRIEFINGS_ENABLED: "true" }, () => as(user, () => m.actions.runBriefingNow(created.id))), { ok: true });

		await m.BriefingRun.create({ accountId: user.accountId, briefingId: created.id, newsletterId: user.newsletterId, slot: "manual:2026-10-28T08:00:00.000Z", isManual: true, stage: "done", status: "drafted", counts: { picked: 4 }, costUsd: 0.0123, checks: [{ id: "links", status: "pass", message: "ok" }, { id: "quotes", status: "warning", message: "long" }], startedAt: new Date() });
		const page = renderToStaticMarkup(await as(user, () => m.detail.default({ params: Promise.resolve({ id: created.id }) })));
		assert.match(page, /Dashboard briefing/);
		assert.match(page, /Run by hand/);
		assert.match(page, /\$0\.01/);
		assert.match(page, /1 warning, 1 passed/);
		assert.match(page, /openrouter key \(OpenRouter, …/);
		assert.ok(!page.includes(SECRET));

		assert.equal((await as(user, () => m.actions.deleteBriefing(created.id))).ok, true);
		assert.doesNotMatch(renderToStaticMarkup(await as(user, () => m.list.default())), /Dashboard briefing/);
	});
});
