import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { platformEmails, startTestApp, withEnv } from "./helpers/app.mjs";
import { QSTASH_KEYS, loadSendingModules, setupSender } from "./helpers/sending.mjs";
import { sent } from "./stubs/ses.mjs";

// lib/briefings-delivery.js: what a briefing run leaves behind (docs/BRIEFINGS-DESIGN.md, step 8): one draft per run, one calendar item
// linked to it, a test email to the briefing's test address only, and the run's checks and cost in a note to the owner, never in the issue.
let app;
let m;
let delivery;
let user;
let ContentItem;

const NOTE = /Checks: \d+ passed/;

function payload(overrides = {}) {
	return {
		accountId: String(user.accountId),
		newsletterId: String(user.newsletterId),
		briefingId: "6650f1c2e9b1d4a012345678",
		runId: "6650f1c2e9b1d4a0123456aa",
		slot: "2026-10-28",
		subject: "This week in batteries",
		previewText: "Three stories worth your time",
		markdown: "# This week in batteries\n\nA plant opened in Ohio ([1](https://news.example.com/ohio)).",
		stories: [
			{ externalId: "briefing:6650f1c2e9b1d4a012345678:aaa", title: "A plant opened in Ohio", hook: "It makes cells.", body: "The plant makes cells.", url: "https://news.example.com/ohio", references: [{ label: "The filing", url: "https://filings.example.com/1", kind: "evidence" }] },
			{ externalId: "briefing:6650f1c2e9b1d4a012345678:bbb", title: "Prices fell", hook: "Again.", body: "Prices fell.", url: "https://news.example.com/prices", references: [{ label: "Same page", url: "https://news.example.com/ohio", kind: "reference" }] },
		],
		testEmail: "editor@example.net",
		checks: [
			{ id: "numbers", status: "pass", message: "Every number is in a cited page" },
			{ id: "links", status: "warning", message: "One link answered slowly" },
		],
		costUsd: 0.0042,
		...overrides,
	};
}

before(async () => {
	app = await startTestApp(QSTASH_KEYS);
	m = await loadSendingModules();
	delivery = await import("../lib/briefings-delivery.js");
	ContentItem = (await import("../models/ContentItem.js")).default;
	user = await setupSender(m, "briefing-owner@example.com", { contacts: 3 });
});

after(() => app?.stop());

describe("deliverIssue", () => {
	let first;
	let notesBefore;
	let sentBefore;

	before(async () => {
		notesBefore = platformEmails.length;
		sentBefore = sent.length;
		first = await delivery.deliverIssue(payload());
	});

	test("makes one draft with the issue exactly as written: Markdown, subject and preview text, nothing added", async () => {
		const campaigns = await m.Campaign.find({ accountId: user.accountId, externalId: "briefing:6650f1c2e9b1d4a012345678:2026-10-28" }).lean();
		assert.equal(campaigns.length, 1);
		const [campaign] = campaigns;
		assert.equal(String(campaign._id), first.campaignId);
		assert.equal(campaign.status, "draft");
		assert.equal(campaign.format, "markdown");
		assert.equal(campaign.markdown, payload().markdown);
		assert.equal(campaign.subject, "This week in batteries");
		assert.equal(campaign.previewText, "Three stories worth your time");
		assert.doesNotMatch(JSON.stringify(campaign), /Checks:|Model cost|0\.0042|One link answered slowly/, "the owner's note is not in the campaign");
	});

	test("puts the issue in the content calendar once, linked to the draft, with the stories' pages first and every reference once", async () => {
		const items = await ContentItem.find({ accountId: user.accountId, newsletterId: user.newsletterId }).lean();
		assert.equal(items.length, 1);
		const [item] = items;
		assert.equal(item.channel, "newsletter");
		assert.equal(String(item.campaignId), first.campaignId);
		assert.equal(item.externalId, "briefing:6650f1c2e9b1d4a012345678:2026-10-28");
		assert.deepEqual(item.references.map(({ url, kind }) => [url, kind]), [
			["https://news.example.com/ohio", "reference"],
			["https://news.example.com/prices", "reference"],
			["https://filings.example.com/1", "evidence"],
		]);
		assert.equal(item.references[0].label, "A plant opened in Ohio");
	});

	test("sends the test email to the test address and nobody else, with the issue and without the note", async () => {
		const mails = sent.slice(sentBefore);
		assert.deepEqual(mails.map(({ to }) => to), ["editor@example.net"]);
		const text = JSON.stringify(mails[0]);
		assert.match(mails[0].subject, /This week in batteries/);
		assert.doesNotMatch(text, NOTE);
		assert.doesNotMatch(text, /Model cost/);
		assert.ok((await m.Campaign.findOne({ accountId: user.accountId, _id: first.campaignId }).lean()).testSentAt);
	});

	test("tells the owner the checks and the cost in a separate alert", () => {
		const notes = platformEmails.slice(notesBefore).filter(({ subject }) => /briefing draft is ready/.test(subject));
		assert.equal(notes.length, 1);
		assert.ok(notes[0].to.includes("briefing-owner@example.com"));
		assert.match(notes[0].text, /Checks: 1 passed, 1 warning, 0 blockers\./);
		assert.match(notes[0].text, /Warning: One link answered slowly/);
		assert.match(notes[0].text, /Model cost of this run: \$0\.0042\./);
		assert.match(notes[0].text, /A test email went to editor@example\.net\./);
	});

	test("a retried delivery returns the same draft and makes, sends and notes nothing new", async () => {
		const sentAfterFirst = sent.length;
		const notesAfterFirst = platformEmails.length;
		const again = await delivery.deliverIssue(payload({ subject: "A changed subject", markdown: "Changed" }));
		assert.deepEqual(again, first);
		assert.equal(await m.Campaign.countDocuments({ accountId: user.accountId, externalId: "briefing:6650f1c2e9b1d4a012345678:2026-10-28" }), 1);
		assert.equal((await m.Campaign.findOne({ accountId: user.accountId, _id: first.campaignId }).lean()).markdown, payload().markdown, "the draft is not changed by a retry");
		assert.equal(await ContentItem.countDocuments({ accountId: user.accountId, newsletterId: user.newsletterId }), 1);
		assert.equal(sent.length, sentAfterFirst, "no second test email");
		assert.equal(platformEmails.length, notesAfterFirst, "no second note for the same run");
	});

	test("another slot is another draft and another calendar item", async () => {
		const next = await delivery.deliverIssue(payload({ slot: "2026-10-29", runId: "6650f1c2e9b1d4a0123456bb" }));
		assert.notEqual(next.campaignId, first.campaignId);
		assert.equal(await ContentItem.countDocuments({ accountId: user.accountId, newsletterId: user.newsletterId }), 2);
	});

	test("a briefing without a test address still gets its draft, and the note says no test went out", async () => {
		const notesBefore2 = platformEmails.length;
		const result = await delivery.deliverIssue(payload({ slot: "2026-10-30", runId: "6650f1c2e9b1d4a0123456cc", testEmail: "" }));
		assert.ok(result.campaignId);
		const note = platformEmails.slice(notesBefore2).find(({ subject }) => /briefing draft is ready/.test(subject));
		assert.match(note.text, /The test email to the test address was not sent: the briefing has no test address\./);
	});
});

describe("the API Worker's BriefingsDelivery entrypoint", () => {
	test("delivers through the same module, with the Worker's bindings, as the briefings Worker's RPC call does", async () => {
		const { BriefingsDelivery } = await import("../workers/api/index.js");
		const entrypoint = new BriefingsDelivery({ waitUntil() {} }, { DB: {} });
		const result = await entrypoint.deliverIssue(payload({ slot: "2026-11-02", runId: "6650f1c2e9b1d4a0123456dd" }));
		const campaign = await m.Campaign.findOne({ accountId: user.accountId, _id: result.campaignId }).lean();
		assert.equal(campaign.externalId, "briefing:6650f1c2e9b1d4a012345678:2026-11-02");
		assert.deepEqual(await entrypoint.deliverIssue(payload({ slot: "2026-11-02", runId: "6650f1c2e9b1d4a0123456dd" })), result);
		assert.deepEqual(await entrypoint.notifyOwner({ accountId: String(user.accountId), briefingId: "6650f1c2e9b1d4a012345678", subject: "Stopped at the budget", text: "The run stopped." }), { notified: true });
	});
});

describe("the hourly cron on a self-hosted server", () => {
	const CRON_SECRET = "test-cron-secret-0123456789abcdef";

	async function hourly(env) {
		const { GET } = await import("../app/api/cron/hourly/route.js");
		const lines = [];
		const info = console.info;
		console.info = (line) => lines.push(String(line));
		try {
			const response = await withEnv({ CRON_SECRET, ...env }, () => GET(new Request("http://localhost:3000/api/cron/hourly", { headers: { authorization: `Bearer ${CRON_SECRET}` } })));
			assert.equal(response.status, 200);
		} finally {
			console.info = info;
		}
		return JSON.parse(lines.find((line) => line.startsWith("[hourly] ")).slice("[hourly] ".length)).briefings;
	}

	test("runs a tick of the engine only with BRIEFINGS_IN_CRON=true, and never in the FlockStack Cloud build", async () => {
		assert.equal(await hourly({ BRIEFINGS_IN_CRON: "" }), null);
		assert.equal(await hourly({ BRIEFINGS_IN_CRON: "false" }), null);
		assert.equal(await hourly({ BRIEFINGS_IN_CRON: "true", FLOCKSTACK_CLOUD_BUILD: "true" }), null);
		const tick = await hourly({ BRIEFINGS_IN_CRON: "true", FLOCKSTACK_CLOUD_BUILD: "" });
		assert.equal(typeof tick, "object");
		assert.notEqual(tick, null);
	});
});

describe("issueReferences", () => {
	test("keeps http(s) links only, each once, at most the calendar's 20", () => {
		const stories = Array.from({ length: 15 }, (_, index) => ({ title: `Story ${index}`, url: `https://news.example.com/${index}`, references: [{ label: "x", url: `https://src.example.com/${index}` }, { url: "javascript:alert(1)" }] }));
		const references = delivery.issueReferences(stories);
		assert.equal(references.length, 20);
		assert.deepEqual(references.slice(0, 15).map(({ url }) => url), stories.map(({ url }) => url));
		assert.ok(references.every(({ url }) => url.startsWith("https://")));
	});
});

describe("notifyOwner", () => {
	test("emails the account owner through the alert helper", async () => {
		const before = platformEmails.length;
		await delivery.notifyOwner({ accountId: user.accountId, briefingId: "6650f1c2e9b1d4a012345678", to: "editor@example.net", subject: "No news today", text: "None of the 12 new items scored 60 or more." });
		const [note] = platformEmails.slice(before);
		assert.match(note.subject, /No news today/);
		assert.ok(note.to.includes("briefing-owner@example.com"));
		assert.match(note.text, /None of the 12 new items/);
	});
});

describe("housekeeping", () => {
	test("the hourly purge deletes briefing runs after 90 days and seen URLs after 30, in every account", async () => {
		const BriefingRun = (await import("../models/BriefingRun.js")).default;
		const BriefingSeen = (await import("../models/BriefingSeen.js")).default;
		const { runAgentHousekeeping } = await import("../lib/agent-housekeeping.js");
		const day = 86_400_000;
		const briefingId = "6650f1c2e9b1d4a012345699";
		const scope = { accountId: user.accountId };
		await BriefingRun.create({ ...scope, briefingId, newsletterId: user.newsletterId, slot: "2026-10-01", status: "drafted" });
		await BriefingSeen.create({ ...scope, briefingId, urlHash: "old", firstSeenAt: new Date(Date.now() - 31 * day) });
		await BriefingSeen.create({ ...scope, briefingId, urlHash: "new", firstSeenAt: new Date() });
		const soon = await runAgentHousekeeping(new Date(Date.now() + 2 * day));
		assert.equal(soon.briefingRunsDeleted, 0);
		assert.equal(soon.briefingSeenDeleted, 1);
		assert.deepEqual((await BriefingSeen.find({ ...scope, briefingId }).lean()).map(({ urlHash }) => urlHash), ["new"]);
		assert.equal(await BriefingRun.countDocuments({ ...scope, briefingId }), 1);
		const later = await runAgentHousekeeping(new Date(Date.now() + 91 * day));
		assert.equal(later.briefingRunsDeleted, 1);
		assert.equal(await BriefingRun.countDocuments({ ...scope, briefingId }), 0);
	});
});
