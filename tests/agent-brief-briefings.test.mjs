import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startTestApp } from "./helpers/app.mjs";
import { addDraft, agentOwner, api, callTool, loadAgentModules, makeKey } from "./helpers/agents.mjs";

// get_agent_brief's briefings: each briefing's last runs (status, cost against the cap, stories per section, held and why,
// translations that failed), its next run and what waits for the owner, for the account or one newsletter, never another's.
let app;
let m;
let owner;
let first;
let second;
let draftId;
let latestRun;
const NOW = new Date();
const daysAgo = (days) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
const KEYS = Array.from({ length: 4 }, (_, index) => String(index + 1).repeat(64));

before(async () => {
	app = await startTestApp();
	m = {
		...(await loadAgentModules()),
		Briefing: (await import("../models/Briefing.js")).default,
		BriefingRun: (await import("../models/BriefingRun.js")).default,
		BriefingVerdict: (await import("../models/BriefingVerdict.js")).default,
	};
	owner = await agentOwner(m, "brief-runs@example.com");
	const own = { accountId: owner.accountId };
	first = await m.Briefing.create({ ...own, newsletterId: owner.newsletterId, name: "Morning", status: "active", schedule: { days: [1, 2, 3, 4, 5], time: "06:00", timeZone: "Europe/Paris" }, budgetUsd: 0.25, nextRunAt: new Date("2026-11-02T05:00:00Z"), languages: ["en", "fr", "de"] });
	second = await m.Briefing.create({ ...own, newsletterId: owner.otherNewsletterId, name: "Weekly", status: "paused", schedule: { days: [1], time: "07:00", timeZone: "UTC" }, budgetUsd: 1, nextRunAt: new Date("2026-11-02T07:00:00Z") });
	draftId = await addDraft(m, owner.keys.full, { subject: "Morning, Oct 28" });
	const run = (fields) => m.BriefingRun.create({ ...own, briefingId: first._id, newsletterId: owner.newsletterId, stage: "done", ...fields });
	await run({ slot: "2026-10-20", status: "drafted", costUsd: 0.01, createdAt: daysAgo(9) });
	await run({ slot: "2026-10-25", status: "failed", error: `The write step's provider answered 500. ${"x".repeat(400)}`, costUsd: 0.002, createdAt: daysAgo(4), finishedAt: daysAgo(4) });
	await run({ slot: "manual:2026-10-27T10:00:00.000Z", isManual: true, status: "stopped_at_budget", costUsd: 0.2498, createdAt: daysAgo(2), finishedAt: daysAgo(2) });
	latestRun = await run({
		slot: "2026-10-28",
		status: "drafted",
		costUsd: 0.0123,
		counts: { picked: 4 },
		heldReason: "checks",
		campaignId: draftId,
		sections: [{ id: "lead", title: "Lead", status: "written", items: 1, costUsd: 0.004 }, { id: "deal-flow", title: "Deal flow", status: "written", items: 3, costUsd: 0.006 }, { id: "people", title: "People moves", status: "empty", items: 0, costUsd: 0 }],
		stories: KEYS.map((storyKey, index) => ({ storyKey, title: `Story ${index + 1}`, url: `https://news.example.com/${index}`, kind: "brief", score: 70, sectionId: index ? "deal-flow" : "lead" })),
		languages: [{ language: "fr", status: "done" }, { language: "de", status: "failed", problem: "The provider answered 500" }],
		work: { draft: "WORKING_DATA" },
		createdAt: daysAgo(1),
		finishedAt: daysAgo(1),
	});
	await m.BriefingVerdict.create({ ...own, briefingId: first._id, runId: latestRun._id, storyKey: KEYS[0], url: "https://news.example.com/0", verdict: "keep", decidedAt: NOW });
});

after(() => app?.stop());

const brief = async (key, query = "") => {
	const response = await api(key, "GET", `/agent/brief${query}`);
	assert.equal(response.status, 200, JSON.stringify(response.body));
	return response.body;
};

describe("briefings in get_agent_brief", () => {
	test("each briefing's last three runs, newest first, with cost against the cap, sections, holds, translations and pending verdicts", async () => {
		const { briefings, nextSteps } = await brief(owner.keys.read_only, `?newsletter=${owner.slug}`);
		assert.equal(briefings.length, 1, "only the newsletter asked about");
		const [morning] = briefings;
		assert.equal(morning.name, "Morning");
		assert.equal(morning.status, "active");
		assert.equal(morning.schedule, "Weekdays at 06:00 (Europe/Paris)");
		assert.equal(morning.nextRunAt, "2026-11-02T05:00:00.000Z");
		assert.equal(morning.budgetUsd, 0.25);
		assert.deepEqual(morning.runs.map(({ slot }) => slot), ["2026-10-28", "manual:2026-10-27T10:00:00.000Z", "2026-10-25"], "the last three, newest first");

		const [latest, stopped, failed] = morning.runs;
		assert.deepEqual(latest, {
			id: String(latestRun._id),
			slot: "2026-10-28",
			manual: false,
			status: "drafted",
			costUsd: 0.0123,
			picked: 4,
			sections: [{ id: "lead", items: 1, status: "written" }, { id: "deal-flow", items: 3, status: "written" }, { id: "people", items: 0, status: "empty" }],
			held: "checks",
			campaignId: draftId,
			draft: "waiting",
			failedLanguages: [{ language: "de", status: "failed" }],
			verdictsPending: 3,
			error: null,
		});
		assert.equal(stopped.manual, true);
		assert.equal(stopped.costUsd, 0.2498);
		assert.equal(stopped.draft, null);
		assert.equal(stopped.verdictsPending, 0, "a run that made no draft has nothing to rate");
		assert.equal(failed.status, "failed");
		assert.ok(failed.error.length <= 200, "errors are clipped");
		assert.equal(JSON.stringify(morning).includes("WORKING_DATA"), false, "the run's working data stays out");

		assert.deepEqual(morning.needsOwner, [
			`The 2026-10-28 draft waits for review (held: a check did not pass): campaign ${draftId}.`,
			"3 stories of the 2026-10-28 run have no keep or drop yet (rate_briefing_story).",
			"The 2026-10-28 run has no de translation (failed).",
		]);
		assert.ok(nextSteps.includes("Briefings have 3 items waiting for the owner: see briefings[].needsOwner."));
	});

	test("the account's briefings when no newsletter is named; a paused one has no next run", async () => {
		const { briefings } = await brief(owner.keys.read_only);
		assert.deepEqual(briefings.map(({ name }) => name), ["Morning", "Weekly"]);
		const weekly = briefings[1];
		assert.equal(weekly.newsletterId, owner.otherNewsletterId);
		assert.equal(weekly.status, "paused");
		assert.equal(weekly.nextRunAt, null, "a paused briefing runs only when asked");
		assert.deepEqual(weekly.runs, []);
		assert.deepEqual(weekly.needsOwner, []);
	});

	test("a key limited to one newsletter sees only its briefings and can't ask about another's", async () => {
		const limited = await makeKey(m, owner, "read_only", { name: "Second only", newsletter: owner.otherNewsletterId });
		const { briefings } = await brief(limited);
		assert.deepEqual(briefings.map(({ name }) => name), ["Weekly"]);
		assert.equal((await api(limited, "GET", `/agent/brief?newsletter=${owner.slug}`)).status, 403);
		const other = await agentOwner(m, "brief-runs-other@example.com");
		assert.deepEqual((await brief(other.keys.read_only)).briefings, [], "another account's briefings never show");
	});

	test("MCP answers what REST does, and a reviewed draft or a rated story stops waiting", async () => {
		const rest = await brief(owner.keys.drafts, `?newsletter=${owner.slug}`);
		const viaMcp = (await callTool(m, owner.keys.drafts, "get_agent_brief", { newsletter: owner.slug })).structuredContent;
		assert.deepEqual(viaMcp.briefings, rest.briefings);

		await m.Campaign.updateOne({ accountId: owner.accountId, _id: draftId }, { $set: { status: "sent" } });
		for (const storyKey of KEYS.slice(1)) await m.BriefingVerdict.create({ accountId: owner.accountId, briefingId: first._id, runId: latestRun._id, storyKey, url: "https://news.example.com/x", verdict: "drop", decidedAt: NOW });
		await m.BriefingRun.updateOne({ accountId: owner.accountId, _id: latestRun._id }, { $set: { languages: [{ language: "fr", status: "done" }, { language: "de", status: "done" }] } });
		const [morning] = (await brief(owner.keys.read_only, `?newsletter=${owner.slug}`)).briefings;
		assert.equal(morning.runs[0].draft, "sent");
		assert.equal(morning.runs[0].verdictsPending, 0);
		assert.deepEqual(morning.needsOwner, [], "a stopped run is not the latest any more, and nothing else waits");
	});

	test("the last run's failure or budget stop is said in a line", async () => {
		await m.BriefingRun.create({ accountId: owner.accountId, briefingId: second._id, newsletterId: owner.otherNewsletterId, slot: "2026-10-26", stage: "done", status: "stopped_at_budget", costUsd: 0.99, createdAt: daysAgo(3) });
		const [weekly] = (await brief(owner.keys.read_only, `?newsletter=${owner.otherSlug}`)).briefings;
		assert.deepEqual(weekly.needsOwner, ["The last run stopped at its $1.00 cap: raise budgetUsd or narrow the briefing."]);
		await m.BriefingRun.create({ accountId: owner.accountId, briefingId: second._id, newsletterId: owner.otherNewsletterId, slot: "2026-10-27", stage: "done", status: "failed", error: "No key for the write step", createdAt: daysAgo(2) });
		assert.deepEqual((await brief(owner.keys.read_only, `?newsletter=${owner.otherSlug}`)).briefings[0].needsOwner, ["The last run failed: No key for the write step."]);
	});
});
