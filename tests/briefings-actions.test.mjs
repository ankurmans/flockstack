import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, describe, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { as, callApi, withEnv } from "./helpers/app.mjs";
import { setupAudienceTests } from "./helpers/audience.mjs";

// Briefings' actions (docs/BRIEFINGS-DESIGN.md, Actions): a brief instead of sources, discovery on the account's own search key,
// schedule, steps on its own AI keys, runs asked for and read back, the owner's keep or drop on each story, over REST, the dashboard's
// server actions and the confirmation page of the owner's email links. The engine itself is tests/briefings-engine*.

const SECRET = "sk-MADEUP-briefings-0123456789SECRET";
const BRIEF = { topic: "Battery manufacturing in Europe", audience: "Engineers at small battery companies", useful: "New plants, prices and rules" };
const AT = (text) => new Date(text);

let t;
let m;

async function addKey(user, provider, key = `${SECRET}-${provider}`) {
	const response = await t.api(user.key, "POST", "/ai-keys", { name: `${provider} key`, provider, key });
	assert.equal(response.status, 201, JSON.stringify(response.body));
	return response.body;
}

async function addSearchKey(user, provider = "tinyfish") {
	const response = await t.api(user.key, "POST", "/ai-keys", { name: `${provider} key`, provider, key: `${SECRET}-${provider}`, ...(provider === "candidate-feed" && { baseUrl: "https://feed.example.com/candidates" }) });
	assert.equal(response.status, 201, JSON.stringify(response.body));
	return response.body;
}

function allSteps(writer, checker, { writeModel = "gpt-4.1-mini", checkModel = "gpt-4.1-nano", translate = false } = {}) {
	return {
		query: { keyId: writer.id, model: writeModel },
		triage: { keyId: writer.id, model: writeModel },
		extract: { keyId: writer.id, model: writeModel },
		write: { keyId: writer.id, model: writeModel },
		check: { keyId: checker.id, model: checkModel },
		...(translate && { translate: { keyId: writer.id, model: writeModel } }),
	};
}

// A finished run as the engine leaves it, with two stories and the ranker's features on each.
function makeRun(user, briefing, fields = {}) {
	return m.BriefingRun.create({
		accountId: user.accountId,
		briefingId: briefing.id,
		newsletterId: briefing.newsletterId,
		slot: "2026-10-27",
		stage: "done",
		status: "drafted",
		counts: { queries: 12, results: 90, candidates: 70, fresh: 40, groups: 30, shortlisted: 20, picked: 2 },
		queries: [{ text: "battery plant europe", angle: "plants" }],
		discoveryNotes: [{ provider: "tinyfish", problem: "Hourly limit reached", scope: "hour", until: AT("2026-10-27T06:00:00Z") }],
		stories: [
			{ storyKey: "a".repeat(64), externalId: "briefing:x:a", kind: "full", title: "A plant opened in Ohio", url: "https://www.news.example.com/ohio", sourceKind: "reporting", score: 82, foundBy: ["gdelt"], sources: [], features: { relevance: 0.9, novelty: 0.4 }, previewImage: "https://cdn.example.com/ohio.jpg" },
			{ storyKey: "b".repeat(64), externalId: "briefing:x:b", kind: "brief", title: "Prices fell", url: "https://prices.example.org/fell", sourceKind: "press_release", score: 61, foundBy: ["hn"], sources: [], features: { relevance: 0.6 } },
		],
		costUsd: 0.0049,
		checks: [{ id: "numbers", status: "pass", message: "Every number is in its source" }, { id: "length", status: "warning", message: "A little long" }],
		thin: true,
		heldReason: "review_mode",
		startedAt: AT("2026-10-27T05:00:00Z"),
		createdAt: AT("2026-10-27T05:00:00Z"),
		work: { draft: "WORKING_DATA" },
		...fields,
	});
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
		BriefingVerdict: (await import("../models/BriefingVerdict.js")).default,
		BriefingPublisher: (await import("../models/BriefingPublisher.js")).default,
		runPage: await import("../app/(app)/briefings/[id]/runs/[runId]/page.js"),
		verdictPage: await import("../app/briefing-verdict/[token]/page.js"),
		verdictActions: await import("../app/briefing-verdict/actions.js"),
		links: await import("../lib/briefing-verdict-links.js"),
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
	let search;

	before(async () => {
		user = await t.customer("briefings-manage@example.com");
		openai = await addKey(user, "openai");
		groq = await addKey(user, "groq");
		search = await addSearchKey(user);
	});

	test("created paused with the defaults, a brief instead of sources, hosts as lower-case names and the owner as test email", async () => {
		const created = await t.api(user.key, "POST", "/briefings", {
			name: "Morning briefing",
			brief: { ...BRIEF, examples: [{ url: "https://news.example.com/a-good-one", note: "Numbers and a named source" }] },
			trustedOutlets: ["News.Example.com", "www.blog.example.org.", "news.example.com"],
			blockedHosts: ["paywalled.example.net"],
			schedule: { days: [5, 1, 1], timeZone: "europe/paris" },
		});
		assert.equal(created.status, 201, JSON.stringify(created.body));
		const briefing = created.body;
		assert.deepEqual([briefing.status, briefing.nextRunAt, briefing.reviewMode, briefing.minScore, briefing.budgetUsd], ["paused", null, "draft", 60, 0.25]);
		assert.deepEqual(briefing.brief, { ...BRIEF, examples: [{ url: "https://news.example.com/a-good-one", note: "Numbers and a named source" }] });
		assert.deepEqual(briefing.trustedOutlets, ["news.example.com", "blog.example.org"]);
		assert.deepEqual(briefing.blockedHosts, ["paywalled.example.net"]);
		assert.deepEqual(briefing.discovery, { searchKey: null, candidateFeedKey: null, maxQueries: 16, resultsPerQuery: 10, maxCandidates: 300, shortlist: 40, followLinks: 5, discoveryBudgetUsd: 0 });
		assert.deepEqual(briefing.stories, { minFull: 6, maxFull: 10, briefItems: 10 });
		assert.deepEqual(briefing.stepBudgets, { query: 5, triage: 10, extract: 35, write: 20, check: 15, translate: 15 });
		assert.deepEqual(briefing.schedule, { days: [1, 5], time: "06:00", timeZone: "Europe/Paris" });
		assert.equal(briefing.testEmail, "briefings-manage@example.com");
		assert.deepEqual(Object.keys(briefing.steps), ["query", "triage", "extract", "write", "check", "translate"]);
		assert.ok(Object.values(briefing.steps).every((step) => step === null));
		assert.equal("sources" in briefing, false);

		const changed = await t.api(user.key, "PATCH", `/briefings/${briefing.id}`, { brief: { topic: "Batteries" }, discovery: { searchKeyId: search.id, maxQueries: 20 }, stories: { briefItems: 0 } });
		assert.equal(changed.status, 200, JSON.stringify(changed.body));
		assert.deepEqual([changed.body.brief.topic, changed.body.brief.audience, changed.body.brief.examples.length], ["Batteries", BRIEF.audience, 1], "the brief keeps what the change leaves out");
		assert.deepEqual(changed.body.discovery.searchKey, { keyId: search.id, keyName: "tinyfish key", keyHint: search.hint, provider: "tinyfish" });
		assert.deepEqual([changed.body.discovery.maxQueries, changed.body.discovery.shortlist, changed.body.stories.briefItems, changed.body.stories.maxFull], [20, 40, 0, 10]);
		assert.ok(!JSON.stringify(changed.body).includes(SECRET));
		assert.equal((await t.api(user.key, "PATCH", `/briefings/${briefing.id}`, { discovery: { searchKeyId: null } })).body.discovery.searchKey, null);

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
		const feed = await addSearchKey(user, "candidate-feed");
		const refusals = [
			[{ brief: { examples: [{ url: "http://news.example.com/a" }] } }, /Example 1: .*https/],
			[{ brief: { examples: [{ url: "https://192.168.1.4/a" }] } }, /Example 1: .*private network/],
			[{ brief: { examples: Array.from({ length: 11 }, (_, index) => ({ url: `https://news.example.com/${index}` })) } }, /examples/],
			[{ brief: { topic: "a".repeat(501) } }, /topic/],
			[{ brief: { useful: "a".repeat(2001) } }, /useful/],
			[{ trustedOutlets: ["https://news.example.com/"] }, /Trusted outlet 1: write a host name/],
			[{ blockedHosts: ["example.com/path"] }, /Blocked host 1/],
			[{ trustedOutlets: Array.from({ length: 51 }, (_, index) => `n${index}.example.com`) }, /trustedOutlets/],
			[{ discovery: { maxQueries: 41 } }, /maxQueries/],
			[{ discovery: { shortlist: 81 } }, /shortlist/],
			[{ discovery: { discoveryBudgetUsd: 21 } }, /discoveryBudgetUsd/],
			[{ discovery: { searchKeyId: openai.id } }, /needs a TinyFish key, not a model key/],
			[{ discovery: { searchKeyId: feed.id } }, /needs a TinyFish key/],
			[{ discovery: { candidateFeedKeyId: search.id } }, /needs a candidate feed key/],
			[{ discovery: { searchKeyId: foreign.id } }, /isn't one of this account's/],
			[{ stories: { minFull: 8, maxFull: 4 } }, /minFull can't be more than stories.maxFull/],
			[{ stories: { maxFull: 16 } }, /maxFull/],
			[{ stories: { briefItems: 21 } }, /briefItems/],
			[{ stepBudgets: { query: 10 } }, /add up to 100, not 105/],
			[{ schedule: { days: [0] } }, /days/],
			[{ schedule: { time: "6am" } }, /time/],
			[{ languages: ["xx"] }, /languages/],
			[{ budgetUsd: 0 }, /budgetUsd/],
			[{ reviewMode: "send_if_checks_pass" }, /isn't available yet/],
			[{ testEmail: "stranger@example.org" }, /team/],
			[{ steps: { triage: { keyId: foreign.id, model: "gpt-4.1-mini" } } }, /isn't one of this account's/],
			[{ steps: { query: { keyId: search.id, model: "x" } } }, /needs a model key, not a search key/],
			[{ steps: { write: { keyId: typesafe.id, model: "jev-latest" } } }, /TypeSafe key can score stories and check claims, not write text/],
			[{ steps: { query: { keyId: typesafe.id, model: "jev-latest" } } }, /not write text: choose another key for the query step/],
			[{ steps: { translate: { keyId: typesafe.id, model: "jev-latest" } } }, /translate step/],
			[{ steps: { write: { keyId: openai.id, model: "gpt-4.1" }, check: { keyId: openai.id, model: "GPT-4.1" } } }, /another model than the write step/],
			[{ status: "active" }, /query, triage, extract, write, check steps/],
		];
		for (const [body, pattern] of refusals) {
			const response = await t.api(user.key, "PATCH", `/briefings/${briefing.id}`, body);
			assert.match(t.assertError(response, 400, "validation_failed"), pattern, JSON.stringify(body).slice(0, 80));
		}
		assert.equal((await t.api(user.key, "PATCH", `/briefings/${briefing.id}`, { stepBudgets: { query: 10, extract: 30 } })).status, 200, "shares that add up to 100");
		assert.equal((await t.api(user.key, "PATCH", `/briefings/${briefing.id}`, { discovery: { candidateFeedKeyId: feed.id } })).body.discovery.candidateFeedKey.provider, "candidate-feed");
		const sameModelOtherProvider = await t.api(user.key, "PATCH", `/briefings/${briefing.id}`, { steps: { write: { keyId: openai.id, model: "llama-3.3-70b" }, check: { keyId: groq.id, model: "llama-3.3-70b" } } });
		assert.equal(sameModelOtherProvider.status, 200, "the same name at another provider is another model");
		const typesafeCheck = await t.api(user.key, "PATCH", `/briefings/${briefing.id}`, { steps: { triage: { keyId: typesafe.id, model: "jev-latest" }, check: { keyId: typesafe.id, model: "jev-latest" } } });
		assert.equal(typesafeCheck.status, 200, JSON.stringify(typesafeCheck.body));
		await m.TeamSeat.create({ accountId: user.accountId, email: "editor@briefings-manage.example.com", role: "editor", status: "active" });
		assert.equal((await t.api(user.key, "PATCH", `/briefings/${briefing.id}`, { testEmail: "Editor@briefings-manage.example.com" })).body.testEmail, "editor@briefings-manage.example.com");
		await t.api(user.key, "PATCH", `/briefings/${briefing.id}`, { steps: Object.fromEntries(["query", "triage", "extract", "write", "check", "translate"].map((step) => [step, null])), discovery: { candidateFeedKeyId: null } });
	});

	test("turned on it needs a topic and the steps it uses, translate only with more than one language; paused, resumed, and keys in use stay", async () => {
		const [briefing] = (await t.api(user.key, "GET", "/briefings")).body.briefings;
		const noTopic = await t.api(user.key, "PATCH", `/briefings/${briefing.id}`, { brief: { topic: " " }, steps: allSteps(openai, groq, { checkModel: "llama-3.3-70b" }), status: "active" });
		assert.match(t.assertError(noTopic, 400, "validation_failed"), /topic/);
		const french = await t.api(user.key, "PATCH", `/briefings/${briefing.id}`, { brief: { topic: "Batteries" }, languages: ["en", "fr"], steps: allSteps(openai, groq, { checkModel: "llama-3.3-70b" }), status: "active" });
		assert.match(t.assertError(french, 400, "validation_failed"), /translate step/);
		const on = await t.api(user.key, "PATCH", `/briefings/${briefing.id}`, { brief: { topic: "Batteries" }, languages: ["en"], discovery: { searchKeyId: search.id }, steps: allSteps(openai, groq, { checkModel: "llama-3.3-70b" }), status: "active", schedule: { days: [1, 2, 3, 4, 5, 6, 7], time: "07:30", timeZone: "UTC" } });
		assert.equal(on.status, 200, JSON.stringify(on.body));
		const next = new Date(on.body.nextRunAt);
		assert.ok(next > new Date() && next - Date.now() <= 86_400_000);
		assert.equal(next.toISOString().slice(11, 16), "07:30");
		assert.deepEqual(on.body.steps.write, { keyId: openai.id, keyName: "openai key", keyHint: openai.hint, provider: "openai", model: "gpt-4.1-mini" });
		assert.equal(on.body.steps.translate, null);
		const translated = await t.api(user.key, "PATCH", `/briefings/${briefing.id}`, { languages: ["en", "fr"], steps: { translate: { keyId: openai.id, model: "gpt-4.1-mini" } } });
		assert.equal(translated.status, 200, JSON.stringify(translated.body));

		const paused = await t.api(user.key, "POST", `/briefings/${briefing.id}/pause`);
		assert.deepEqual([paused.body.status, paused.body.nextRunAt], ["paused", null]);
		const resumed = await t.api(user.key, "POST", `/briefings/${briefing.id}/resume`);
		assert.equal(resumed.body.status, "active");
		assert.ok(new Date(resumed.body.nextRunAt) > new Date());

		assert.match(t.assertError(await t.api(user.key, "DELETE", `/ai-keys/${openai.id}`), 409, "conflict"), /A briefing uses this key/);
		assert.match(t.assertError(await t.api(user.key, "DELETE", `/ai-keys/${search.id}`), 409, "conflict"), /steps or discovery/, "a search key in use stays too");
		assert.equal((await t.api(user.key, "GET", "/ai-keys")).body.keys.find(({ id }) => id === search.id).usedBy, 1);
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
			// Three manual runs a local day: a fourth is refused when asked for, not dropped later without a word.
			const BriefingRun = (await import("../models/BriefingRun.js")).default;
			const now = new Date();
			for (const n of [1, 2, 3]) await BriefingRun.create({ accountId: user.accountId, briefingId: briefing.id, newsletterId: briefing.newsletterId, slot: `manual:test-${n}`, isManual: true, status: "drafted", startedAt: now });
			const fourth = await t.api(user.key, "POST", `/briefings/${briefing.id}/run`);
			assert.match(t.assertError(fourth, 429, "rate_limited"), /3 manual runs today/);
			await BriefingRun.deleteMany({ accountId: user.accountId, briefingId: briefing.id, slot: { $in: ["manual:test-1", "manual:test-2", "manual:test-3"] } });
		});
		await withEnv({ BRIEFINGS_IN_CRON: "true" }, async () => {
			const bare = await t.api(user.key, "POST", "/briefings", { newsletter: (await m.Newsletter.create({ accountId: user.accountId, name: "Second", slug: "briefings-second", fromName: "x", fromEmail: "x@briefings-second.flockstackmail.com" }))._id.toString(), name: "Bare" });
			assert.equal(bare.status, 201, JSON.stringify(bare.body));
			assert.match(t.assertError(await t.api(user.key, "POST", `/briefings/${bare.body.id}/run`), 400, "validation_failed"), /topic/);
		});
	});

	test("runs are listed newest first and read one by one, with discovery's notes and the stories, never with their working data", async () => {
		const [briefing] = (await t.api(user.key, "GET", "/briefings")).body.briefings;
		const older = await makeRun(user, briefing, { slot: "2026-10-26", status: "no_news", stories: [], startedAt: AT("2026-10-26T05:00:00Z"), createdAt: AT("2026-10-26T05:00:00Z") });
		const newer = await makeRun(user, briefing);
		const listed = await t.api(user.key, "GET", `/briefings/${briefing.id}/runs`);
		assert.deepEqual(listed.body.runs.map(({ id }) => id), [String(newer._id), String(older._id)]);
		assert.deepEqual((await t.api(user.key, "GET", `/briefings/${briefing.id}/runs?limit=1`)).body.runs.map(({ id }) => id), [String(newer._id)]);
		const one = (await t.api(user.key, "GET", `/briefing-runs/${newer._id}`)).body;
		assert.deepEqual([one.status, one.counts.shortlisted, one.costUsd, one.checks.length, one.thin, one.heldReason], ["drafted", 20, 0.0049, 2, true, "review_mode"]);
		assert.deepEqual(one.queries, [{ text: "battery plant europe", angle: "plants" }]);
		assert.deepEqual(one.discoveryNotes, [{ provider: "tinyfish", problem: "Hourly limit reached", scope: "hour", until: "2026-10-27T06:00:00.000Z" }]);
		assert.deepEqual(one.stories.map(({ storyKey, kind, sourceKind, verdict }) => [storyKey.slice(0, 1), kind, sourceKind, verdict]), [["a", "full", "reporting", null], ["b", "brief", "press_release", null]]);
		assert.deepEqual(one.stories.map(({ previewImage }) => previewImage), ["https://cdn.example.com/ohio.jpg", null], "the source page's og:image, for the owner's link preview");
		for (const body of [listed.body, one, (await t.api(user.key, "GET", `/briefings/${briefing.id}`)).body]) {
			assert.ok(!JSON.stringify(body).includes("WORKING_DATA"));
			assert.ok(!JSON.stringify(body).includes('"work"'));
			assert.ok(!JSON.stringify(body).includes('"features"'), "what the ranker saw stays inside");
		}
		const other = await t.customer("briefings-runs-other@example.com");
		t.assertError(await t.api(other.key, "GET", `/briefing-runs/${newer._id}`), 404, "not_found");
	});

	test("rate_briefing_story saves the verdict with the ranker's features, counts it for the host once, and a new verdict replaces it", async () => {
		const [briefing] = (await t.api(user.key, "GET", "/briefings")).body.briefings;
		const run = await makeRun(user, briefing, { slot: "2026-10-28" });
		const key = "a".repeat(64);
		const kept = await t.api(user.key, "POST", `/briefing-runs/${run._id}/stories/${key}/verdict`, { verdict: "keep" });
		assert.equal(kept.status, 200, JSON.stringify(kept.body));
		assert.deepEqual([kept.body.runId, kept.body.storyKey, kept.body.verdict], [String(run._id), key, "keep"]);
		const saved = await m.BriefingVerdict.findOne({ accountId: user.accountId, runId: run._id, storyKey: key }).lean();
		assert.deepEqual([saved.verdict, saved.url, saved.features, String(saved.briefingId)], ["keep", "https://www.news.example.com/ohio", { relevance: 0.9, novelty: 0.4 }, briefing.id]);
		const host = () => m.BriefingPublisher.findOne({ accountId: user.accountId, briefingId: briefing.id, host: "news.example.com" }).lean();
		assert.deepEqual([(await host()).kept, (await host()).dropped], [1, 0]);
		await t.api(user.key, "POST", `/briefing-runs/${run._id}/stories/${key}/verdict`, { verdict: "keep" });
		assert.deepEqual([(await host()).kept, (await host()).dropped], [1, 0], "the same verdict again counts nothing");
		await t.api(user.key, "POST", `/briefing-runs/${run._id}/stories/${key}/verdict`, { verdict: "drop" });
		assert.deepEqual([(await host()).kept, (await host()).dropped], [0, 1]);
		assert.equal(await m.BriefingVerdict.countDocuments({ accountId: user.accountId, runId: run._id }), 1);
		assert.equal((await t.api(user.key, "GET", `/briefing-runs/${run._id}`)).body.stories[0].verdict, "drop");

		t.assertError(await t.api(user.key, "POST", `/briefing-runs/${run._id}/stories/${"c".repeat(64)}/verdict`, { verdict: "keep" }), 404, "not_found");
		t.assertError(await t.api(user.key, "POST", `/briefing-runs/${run._id}/stories/${key}/verdict`, { verdict: "maybe" }), 400, "validation_failed");
		const other = await t.customer("briefings-rate-other@example.com");
		t.assertError(await t.api(other.key, "POST", `/briefing-runs/${run._id}/stories/${key}/verdict`, { verdict: "keep" }), 404, "not_found");
		const drafts = await t.createKey(user, "drafts");
		assert.equal((await t.api(drafts, "POST", `/briefing-runs/${run._id}/stories/${"b".repeat(64)}/verdict`, { verdict: "keep" })).status, 200, "a drafts key may rate");
	});

	test("deleting a briefing takes its runs, memory, verdicts and publishers with it, and frees its keys", async () => {
		const [briefing] = (await t.api(user.key, "GET", "/briefings")).body.briefings;
		await m.BriefingSeen.create({ accountId: user.accountId, briefingId: briefing.id, urlHash: "a".repeat(64), firstSeenAt: new Date() });
		assert.deepEqual((await t.api(user.key, "DELETE", `/briefings/${briefing.id}`)).body, { id: briefing.id, deleted: true });
		for (const Model of [m.BriefingRun, m.BriefingSeen, m.BriefingVerdict, m.BriefingPublisher]) assert.equal(await Model.countDocuments({ accountId: user.accountId, briefingId: briefing.id }), 0, Model.modelName);
		assert.equal((await t.api(user.key, "DELETE", `/ai-keys/${openai.id}`)).status, 200);
		assert.equal((await t.api(user.key, "DELETE", `/ai-keys/${search.id}`)).status, 200);
	});
});

describe("verdict links", () => {
	let user;
	let briefing;
	let run;
	const KEY = "a".repeat(64);

	before(async () => {
		user = await t.customer("briefings-links@example.com");
		briefing = (await t.api(user.key, "POST", "/briefings", { name: "Linked briefing", brief: BRIEF })).body;
		run = await makeRun(user, briefing);
	});

	test("are signed, single-purpose and expire after 14 days", () => {
		const token = m.links.createVerdictToken({ accountId: user.accountId, runId: run._id, storyKey: KEY, verdict: "keep" });
		const link = m.links.verifyVerdictToken(token);
		assert.deepEqual([link.accountId, link.runId, link.storyKey, link.verdict], [String(user.accountId), String(run._id), KEY, "keep"]);
		assert.match(link.linkId, /^[A-Za-z0-9_-]{16}$/);
		assert.notEqual(m.links.verifyVerdictToken(m.links.createVerdictToken({ accountId: user.accountId, runId: run._id, storyKey: KEY, verdict: "keep" })).linkId, link.linkId, "each link has its own id");
		const [payload, signature] = token.split(".");
		const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url")), v: "drop" })).toString("base64url");
		assert.equal(m.links.verifyVerdictToken(`${forged}.${signature}`), null, "a changed verdict breaks the signature");
		assert.equal(m.links.verifyVerdictToken(token, Date.now() + 15 * 86_400_000), null);
		assert.equal(m.links.getVerdictLinkUrl("https://app.example.com/", token), `https://app.example.com/briefing-verdict/${token}`);
	});

	test("opening one records nothing; its button records the verdict once, and a second press says it is already recorded", async () => {
		const { anonymous, catchRedirect, form } = await import("./helpers/app.mjs");
		const token = m.links.createVerdictToken({ accountId: user.accountId, runId: run._id, storyKey: KEY, verdict: "drop" });
		const open = () => anonymous(async () => renderToStaticMarkup(await m.verdictPage.default({ params: Promise.resolve({ token }), searchParams: Promise.resolve({}) })));
		const page = await open();
		assert.match(page, /Drop this story\?/);
		assert.match(page, /A plant opened in Ohio/);
		assert.match(page, /Linked briefing/);
		const preview = /<img [^>]*>/.exec(page)?.[0] ?? "";
		for (const attribute of ['src="https://cdn.example.com/ohio.jpg"', 'alt="A plant opened in Ohio"', 'width="56"', 'height="56"', 'loading="lazy"', 'referrerPolicy="no-referrer"']) assert.ok(preview.includes(attribute), `${attribute} in ${preview}`);
		assert.match(page, /href="https:\/\/www\.news\.example\.com\/ohio"[^>]*rel="noreferrer noopener"/);
		assert.match(page, new RegExp(`name="token" value="${token.replace(/[.]/g, "\\.")}"`));
		await open();
		assert.equal(await m.BriefingVerdict.countDocuments({ accountId: user.accountId, runId: run._id }), 0, "a GET, a scanner or a preview records nothing");
		assert.deepEqual(m.verdictPage.metadata.robots, { index: false, follow: false });
		assert.equal(m.verdictPage.metadata.referrer, "no-referrer");
		assert.equal(m.verdictPage.dynamic, "force-dynamic");

		const pressed = await anonymous(() => catchRedirect(m.verdictActions.confirmVerdict(form({ token }))));
		assert.equal(pressed, `/briefing-verdict/${token}?result=recorded`);
		const saved = await m.BriefingVerdict.findOne({ accountId: user.accountId, runId: run._id, storyKey: KEY }).lean();
		assert.deepEqual([saved.verdict, saved.decidedBy, saved.features], ["drop", "email-link", { relevance: 0.9, novelty: 0.4 }]);
		assert.equal(saved.linkId, m.links.verifyVerdictToken(token).linkId);
		assert.equal((await m.BriefingPublisher.findOne({ accountId: user.accountId, briefingId: briefing.id, host: "news.example.com" }).lean()).dropped, 1);

		assert.equal(await anonymous(() => catchRedirect(m.verdictActions.confirmVerdict(form({ token })))), `/briefing-verdict/${token}?result=already`);
		const keep = m.links.createVerdictToken({ accountId: user.accountId, runId: run._id, storyKey: KEY, verdict: "keep" });
		assert.equal(await anonymous(() => catchRedirect(m.verdictActions.confirmVerdict(form({ token: keep })))), `/briefing-verdict/${keep}?result=already`, "the other link doesn't overturn a verdict either");
		assert.equal((await m.BriefingVerdict.findOne({ accountId: user.accountId, runId: run._id, storyKey: KEY }).lean()).verdict, "drop");
		assert.equal((await m.BriefingPublisher.findOne({ accountId: user.accountId, briefingId: briefing.id, host: "news.example.com" }).lean()).dropped, 1);
		assert.match(await anonymous(async () => renderToStaticMarkup(await m.verdictPage.default({ params: Promise.resolve({ token: keep }), searchParams: Promise.resolve({ result: "already" }) }))), /Already recorded/);

		const bad = await anonymous(async () => renderToStaticMarkup(await m.verdictPage.default({ params: Promise.resolve({ token: `${token}x` }), searchParams: Promise.resolve({}) })));
		assert.match(bad, /This link doesn&#x27;t work/);
		assert.equal(await anonymous(() => catchRedirect(m.verdictActions.confirmVerdict(form({ token: "nope" })))), "/briefing-verdict/nope");
	});

	test("a link with a broken escape (%, %zz) shows the invalid-link page instead of failing", async () => {
		const { anonymous } = await import("./helpers/app.mjs");
		for (const token of ["%", "abc%zz", "%E0%A4%A"]) {
			const page = await anonymous(async () => renderToStaticMarkup(await m.verdictPage.default({ params: Promise.resolve({ token }), searchParams: Promise.resolve({}) })));
			assert.match(page, /This link doesn&#x27;t work/, token);
		}
	});
});

describe("sections", () => {
	let user;
	let briefing;
	const SECTIONS = [
		{ id: "lead", title: "Lead", purpose: "The day's most important story, with its numbers", format: "sentences", maxItems: 1, budgetShare: 30, priority: 1 },
		{ id: "deal-flow", title: "Deal flow", purpose: "Acquisitions and funding rounds, each with the amount", format: "one-liners", maxItems: 12, budgetShare: 40, priority: 2 },
		{ id: "people", title: "People moves", format: "one-liners", maxItems: 6 },
	];

	before(async () => {
		user = await t.customer("briefings-sections@example.com");
		briefing = (await t.api(user.key, "POST", "/briefings", { name: "Sectioned", brief: BRIEF, sections: SECTIONS })).body;
	});

	test("go round trip through create, get and update; a list sent replaces it, and [] goes back to the unsectioned layout", async () => {
		const expected = SECTIONS.map((section) => ({ purpose: "", budgetShare: null, priority: null, icon: null, ...section }));
		assert.deepEqual(briefing.sections, expected);
		assert.deepEqual((await t.api(user.key, "GET", `/briefings/${briefing.id}`)).body.sections, expected);
		const reordered = await t.api(user.key, "PATCH", `/briefings/${briefing.id}`, { sections: [{ ...SECTIONS[2], id: "People", budgetShare: 10 }, SECTIONS[0]] });
		assert.equal(reordered.status, 200, JSON.stringify(reordered.body));
		assert.deepEqual(reordered.body.sections.map(({ id, budgetShare }) => [id, budgetShare]), [["people", 10], ["lead", 30]], "reading order kept, ids lower-cased");
		assert.deepEqual((await t.api(user.key, "PATCH", `/briefings/${briefing.id}`, { name: "Renamed" })).body.sections.length, 2, "a change without sections keeps them");
		const cleared = await t.api(user.key, "PATCH", `/briefings/${briefing.id}`, { sections: [] });
		assert.deepEqual(cleared.body.sections, []);
		assert.deepEqual((await m.Briefing.findOne({ accountId: user.accountId, _id: briefing.id }).lean()).sections, []);
		await t.api(user.key, "PATCH", `/briefings/${briefing.id}`, { sections: SECTIONS });
		assert.equal(m.scopes.getActionClass("update_briefing", { sections: SECTIONS }), "write", "a sections change is write");
	});

	test("refuses sections the rules don't allow, saying why", async () => {
		const one = (change) => [{ ...SECTIONS[1], ...change }];
		const refusals = [
			[Array.from({ length: 13 }, (_, index) => ({ id: `s${index}`, title: `S${index}`, format: "one-liners", maxItems: 1 })), /sections/],
			[one({ id: "Deal Flow" }), /lower-case letters, digits and dashes/],
			[one({ id: "-deals" }), /lower-case letters/],
			[[SECTIONS[0], { ...SECTIONS[1], id: "lead" }], /Section 2: another section has the id lead/],
			[one({ title: "" }), /title/],
			[one({ title: "a".repeat(61) }), /title/],
			[one({ purpose: "a".repeat(401) }), /purpose/],
			[one({ format: "paragraphs" }), /format/],
			[one({ maxItems: 0 }), /maxItems/],
			[one({ maxItems: 26 }), /maxItems/],
			[one({ budgetShare: 12.5 }), /budgetShare/],
			[[{ ...SECTIONS[0], budgetShare: 60 }, { ...SECTIONS[1], budgetShare: 41 }], /add up to 100 at most, not 101/],
			[one({ priority: 0 }), /priority/],
			[one({ priority: 13 }), /priority/],
		];
		for (const [sections, pattern] of refusals) {
			const response = await t.api(user.key, "PATCH", `/briefings/${briefing.id}`, { sections });
			assert.match(t.assertError(response, 400, "validation_failed"), pattern, JSON.stringify(sections).slice(0, 80));
		}
		assert.equal((await t.api(user.key, "PATCH", `/briefings/${briefing.id}`, { sections: [{ ...SECTIONS[0], budgetShare: 60 }, { ...SECTIONS[1], budgetShare: 40 }] })).status, 200, "shares of exactly 100");
		assert.equal((await t.api(user.key, "PATCH", `/briefings/${briefing.id}`, { sections: SECTIONS.map(({ budgetShare: _share, ...section }) => section) })).status, 200, "no shares: split evenly");
	});

	test("a run shows its sections, and each story's and call's section", async () => {
		const run = await makeRun(user, briefing, {
			slot: "2026-10-29",
			stories: [
				{ storyKey: "a".repeat(64), kind: "full", title: "A plant opened", url: "https://news.example.com/plant", sourceKind: "reporting", score: 80, sectionId: "lead" },
				{ storyKey: "b".repeat(64), kind: "brief", title: "A round closed", url: "https://news.example.com/round", sourceKind: "reporting", score: 70, sectionId: "deal-flow" },
			],
			sections: [
				{ id: "lead", title: "Lead", status: "written", items: 1, costUsd: 0.0021 },
				{ id: "deal-flow", title: "Deal flow", status: "written", items: 1, costUsd: 0.0012 },
				{ id: "people", title: "People moves", status: "empty", items: 0, costUsd: 0 },
			],
			calls: [
				{ step: "write", sectionId: "lead", provider: "openai", model: "gpt-4.1-mini", inputTokens: 900, outputTokens: 80, costUsd: 0.0021, costFrom: "price_table" },
				{ step: "triage", provider: "typesafe", model: "jev-latest", inputTokens: 4000, outputTokens: 0, costUsd: 0.0004, costFrom: "price_table" },
			],
		});
		const one = (await t.api(user.key, "GET", `/briefing-runs/${run._id}`)).body;
		assert.deepEqual(one.sections, [
			{ id: "lead", title: "Lead", status: "written", items: 1, costUsd: 0.0021, problem: null },
			{ id: "deal-flow", title: "Deal flow", status: "written", items: 1, costUsd: 0.0012, problem: null },
			{ id: "people", title: "People moves", status: "empty", items: 0, costUsd: 0, problem: null },
		]);
		assert.deepEqual(one.stories.map(({ sectionId }) => sectionId), ["lead", "deal-flow"]);
		assert.deepEqual(one.calls.map(({ sectionId }) => sectionId), ["lead", null]);
		const [listed] = (await t.api(user.key, "GET", `/briefings/${briefing.id}/runs?limit=1`)).body.runs;
		assert.equal(listed.sections.length, 3);
		const unsectioned = (await t.api(user.key, "GET", `/briefing-runs/${(await makeRun(user, briefing, { slot: "2026-10-30" }))._id}`)).body;
		assert.deepEqual([unsectioned.sections, unsectioned.stories[0].sectionId], [[], null]);

		const page = renderToStaticMarkup(await as(user, () => m.runPage.default({ params: Promise.resolve({ id: briefing.id, runId: String(run._id) }) })));
		assert.match(page, /Sections/);
		assert.match(page, /Deal flow/);
		assert.match(page, /Empty/);
		assert.match(page, /\$0\.0021/);
	});
});

describe("agents", () => {
	test("each action has its class: reads, settings, drafting, deletes and keys", async () => {
		const names = ["list_briefings", "get_briefing", "create_briefing", "update_briefing", "pause_briefing", "resume_briefing", "delete_briefing", "run_briefing", "list_briefing_runs", "get_briefing_run", "rate_briefing_story", "add_ai_key", "list_ai_keys", "check_ai_key", "delete_ai_key"];
		assert.deepEqual(Object.fromEntries(names.map((name) => [name, m.scopes.getActionClass(name, {})])), {
			list_briefings: "read",
			get_briefing: "read",
			create_briefing: "write",
			update_briefing: "write",
			pause_briefing: "write",
			resume_briefing: "write",
			delete_briefing: "destructive",
			run_briefing: "send",
			list_briefing_runs: "read",
			get_briefing_run: "read",
			rate_briefing_story: "write-draft",
			add_ai_key: "admin",
			list_ai_keys: "read",
			check_ai_key: "admin",
			delete_ai_key: "destructive",
		});
		assert.equal(m.scopes.getActionClass("create_briefing", { reviewMode: "send_if_checks_pass" }), "send");
		assert.equal(m.scopes.getActionClass("update_briefing", { reviewMode: "send_if_checks_pass" }), "send");
		assert.equal(m.scopes.isGateable("create_briefing"), true);
		assert.equal(m.scopes.getTargetOf("get_briefing_run").model, "BriefingRun");
		assert.equal(m.scopes.getTargetOf("rate_briefing_story").model, "BriefingRun");
		// Spending more of the account's own model and search money than the default is a send: it can't be taken back.
		for (const name of ["create_briefing", "update_briefing"]) {
			assert.equal(m.scopes.getActionClass(name, { budgetUsd: 0.25 }), "write", name);
			assert.equal(m.scopes.getActionClass(name, { budgetUsd: 0.26 }), "send", name);
			assert.equal(m.scopes.getActionClass(name, { budgetUsd: 20 }), "send", name);
			assert.equal(m.scopes.getActionClass(name, { discovery: { discoveryBudgetUsd: 0 } }), "write", name);
			assert.equal(m.scopes.getActionClass(name, { discovery: { discoveryBudgetUsd: 0.01 } }), "send", name);
		}
		assert.equal(m.scopes.isGateable("run_briefing"), true);
		assert.equal((await import("../lib/briefing-rules.js")).DEFAULT_BUDGET_USD, 0.25, "lib/action-scopes.js repeats the default budget");

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

		// A send with approval key can't raise what a run may spend, nor start runs on the account's keys, without the owner.
		for (const [method, path, body] of [
			["PATCH", `/api/v1/briefings/${created.body.id}`, { budgetUsd: 20 }],
			["PATCH", `/api/v1/briefings/${created.body.id}`, { discovery: { discoveryBudgetUsd: 5 } }],
			["POST", `/api/v1/briefings/${created.body.id}/run`, undefined],
		]) {
			const waiting = await withEnv({ BRIEFINGS_ENABLED: "true" }, () => callApi(method, path, { key: careful, body }));
			assert.equal(waiting.status, 202, `${method} ${path} ${JSON.stringify(body)}`);
			assert.equal(waiting.body.status, "approval_required");
		}
		const stored = await m.Briefing.findOne({ accountId: user.accountId, _id: created.body.id }).lean();
		assert.deepEqual([stored.budgetUsd, stored.discovery?.discoveryBudgetUsd ?? 0, stored.manualRunAt ?? null], [0.25, 0, null], "nothing ran before the owner approved");
		assert.equal((await t.api(careful, "PATCH", `/briefings/${created.body.id}`, { budgetUsd: 0.2 })).status, 200, "spending less runs at once");
		const createExpensive = await callApi("POST", "/api/v1/briefings", { key: careful, body: { newsletter: (await m.Newsletter.create({ accountId: user.accountId, name: "Other", slug: "briefings-agents-other", fromName: "x", fromEmail: "x@briefings-agents-other.flockstackmail.com" }))._id.toString(), name: "Expensive", budgetUsd: 5 } });
		assert.equal(createExpensive.status, 202);
	});

	test("account purge deletes the seven collections", async () => {
		const { CONTENT_MODELS } = await import("../lib/account-purge.js");
		const models = [m.Briefing, m.BriefingRun, m.BriefingSeen, m.BriefingVerdict, m.BriefingPublisher, (await import("../models/DiscoveryUsage.js")).default, (await import("../models/AiProviderKey.js")).default];
		for (const model of models) assert.ok(CONTENT_MODELS.includes(model), model.modelName);
	});
});

describe("the dashboard", () => {
	test("makes, saves, runs and deletes a briefing through the server actions, and the pages show it, its runs and the keep and drop buttons", async () => {
		const user = await t.customer("briefings-dashboard@example.com");
		const writer = await addKey(user, "openrouter");
		const checker = await addKey(user, "typesafe");
		const search = await addSearchKey(user);
		const values = {
			name: "Dashboard briefing",
			topic: BRIEF.topic,
			audience: BRIEF.audience,
			useful: BRIEF.useful,
			examples: [{ url: "https://news.example.com/good", note: "" }, { url: "  ", note: "" }],
			trustedOutlets: "News.example.com\nblog.example.org, www.wire.example.net",
			blockedHosts: "",
			searchKeyId: search.id,
			candidateFeedKeyId: "",
			days: [1, 3],
			time: "06:30",
			timeZone: "UTC",
			styleGuide: "Short",
			languages: ["en", "fr"],
			minFull: "5",
			maxFull: "8",
			briefItems: "4",
			minScore: "70",
			budgetUsd: "0.5",
			steps: {
				query: { keyId: writer.id, model: "qwen/qwen3-30b" },
				triage: { keyId: checker.id, model: "jev-latest" },
				extract: { keyId: writer.id, model: "qwen/qwen3-30b" },
				write: { keyId: writer.id, model: "qwen/qwen3-30b" },
				check: { keyId: checker.id, model: "jev-latest" },
				translate: { keyId: writer.id, model: "qwen/qwen3-30b" },
			},
			testEmail: "briefings-dashboard@example.com",
			active: true,
			sections: [
				{ title: "Market pulse", purpose: "Rate moves", format: "one-liners", maxItems: "6", budgetShare: "", priority: "" },
				{ title: "Market pulse", purpose: "", format: "sentences", maxItems: "2", budgetShare: "30", priority: "1", icon: "earnings" },
				{ title: "  ", purpose: "", format: "one-liners", maxItems: "1", budgetShare: "", priority: "" },
			],
		};
		const bad = await as(user, () => m.actions.createBriefing(user.newsletterId, { ...values, trustedOutlets: "https://news.example.com/" }));
		assert.match(bad.error, /host name/);
		const created = await as(user, () => m.actions.createBriefing(user.newsletterId, values));
		assert.equal(created.ok, true, JSON.stringify(created));
		const stored = await m.Briefing.findOne({ accountId: user.accountId, _id: created.id }).lean();
		assert.deepEqual([stored.status, stored.stories.minFull, stored.stories.maxFull, stored.stories.briefItems, stored.minScore, stored.budgetUsd, stored.brief.examples.length, stored.languages], ["active", 5, 8, 4, 70, 0.5, 1, ["en", "fr"]]);
		assert.deepEqual(stored.trustedOutlets, ["news.example.com", "blog.example.org", "wire.example.net"]);
		assert.equal(String(stored.discovery.searchKeyId), search.id);
		assert.deepEqual(
			stored.sections.map(({ id, format, maxItems, budgetShare, priority }) => [id, format, maxItems, budgetShare ?? null, priority ?? null]),
			[["market-pulse", "one-liners", 6, null, null], ["market-pulse-2", "sentences", 2, 30, 1]],
			"ids made from titles, blank rows dropped, empty numbers left out"
		);
		assert.deepEqual(stored.sections.map(({ icon }) => icon), [undefined, "earnings"], "an icon only when one is picked");
		const editPage = renderToStaticMarkup(await as(user, () => m.detail.default({ params: Promise.resolve({ id: created.id }) })));
		assert.match(editPage, /Add a section/);
		assert.match(editPage, /value="Market pulse"/);
		assert.match(editPage, /aria-label="Icon: Market pulse"/, "a section without an icon shows the one matching its id");
		assert.match(editPage, /aria-label="Icon: Earnings"/);
		assert.match(editPage, /lucide-chart-column|lucide-bar-chart-3/);

		const listed = renderToStaticMarkup(await as(user, () => m.list.default()));
		assert.match(listed, /Dashboard briefing/);
		assert.match(listed, /Mondays and Wednesdays at 06:30 \(UTC\), Battery manufacturing in Europe/);
		assert.match(listed, /None yet/);
		const blank = renderToStaticMarkup(await as(user, () => m.create.default()));
		assert.match(blank, /openrouter key \(OpenRouter, …/);
		assert.match(blank, /under your own TinyFish account and terms/);

		assert.equal((await as(user, () => m.actions.updateBriefing(created.id, { ...values, active: false }))).ok, true);
		assert.equal((await m.Briefing.findOne({ accountId: user.accountId, _id: created.id }).lean()).status, "paused");
		const unavailable = await withEnv({ BRIEFINGS_ENABLED: "", BRIEFINGS_IN_CRON: "" }, () => as(user, () => m.actions.runBriefingNow(created.id)));
		assert.match(unavailable.error, /don't run on this server/);
		assert.deepEqual(await withEnv({ BRIEFINGS_ENABLED: "true" }, () => as(user, () => m.actions.runBriefingNow(created.id))), { ok: true });

		const run = await makeRun(user, { id: created.id, newsletterId: user.newsletterId }, { slot: "manual:2026-10-28T08:00:00.000Z", isManual: true, costUsd: 0.0123, startedAt: new Date() });
		const page = renderToStaticMarkup(await as(user, () => m.detail.default({ params: Promise.resolve({ id: created.id }) })));
		assert.match(page, /Dashboard briefing/);
		assert.match(page, /Run by hand/);
		assert.match(page, /\$0\.01/);
		assert.match(page, /1 warning, 1 passed/);
		assert.match(page, new RegExp(`/briefings/${created.id}/runs/${run._id}`));
		assert.ok(!page.includes(SECRET));

		const runPage = renderToStaticMarkup(await as(user, () => m.runPage.default({ params: Promise.resolve({ id: created.id, runId: String(run._id) }) })));
		assert.match(runPage, /A plant opened in Ohio/);
		assert.match(runPage, /<img [^>]*src="https:\/\/cdn\.example\.com\/ohio\.jpg"[^>]*>/);
		assert.equal((runPage.match(/<img /g) ?? []).length, 1, "a story without a preview image gets an icon instead");
		assert.match(runPage, /referrerPolicy="no-referrer"/);
		assert.match(runPage, /Press release/);
		assert.match(runPage, /Keep/);
		assert.match(runPage, /battery plant europe/);
		assert.match(runPage, /Hourly limit reached/);
		assert.match(runPage, /GDELT Project/);
		assert.deepEqual(await as(user, () => m.actions.rateBriefingStory(created.id, String(run._id), "b".repeat(64), "keep")), { ok: true, verdict: "keep" });
		assert.equal((await m.BriefingVerdict.findOne({ accountId: user.accountId, runId: run._id, storyKey: "b".repeat(64) }).lean()).decidedBy, String(user.userId));

		assert.equal((await as(user, () => m.actions.deleteBriefing(created.id))).ok, true);
		assert.doesNotMatch(renderToStaticMarkup(await as(user, () => m.list.default())), /Dashboard briefing/);
	});
});
