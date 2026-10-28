import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { as, platformEmails, startTestApp, withEnv } from "./helpers/app.mjs";
import { QSTASH_KEYS, loadSendingModules, setupSender } from "./helpers/sending.mjs";
import { sent } from "./stubs/ses.mjs";

// lib/briefings-delivery.js: what a briefing run leaves behind (docs/BRIEFINGS-DESIGN.md, step 9): one draft per run (never a send),
// its translations for readers who choose them, one calendar item linked to it, a test email to the briefing's test address only, and a
// note to the owner, never in the issue, with the checks, the cost, what discovery could not do and a keep and drop link per story.
let app;
let m;
let delivery;
let user;
let ContentItem;
let IssueTranslation;

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
			{ storyKey: "a".repeat(64), kind: "full", sourceKind: "reporting", externalId: "briefing:6650f1c2e9b1d4a012345678:aaa", title: "A plant opened in Ohio", hook: "It makes cells.", body: "The plant makes cells.", url: "https://news.example.com/ohio", references: [{ label: "The filing", url: "https://filings.example.com/1", kind: "evidence" }] },
			{ storyKey: "b".repeat(64), kind: "brief", sourceKind: "press_release", externalId: "briefing:6650f1c2e9b1d4a012345678:bbb", title: "Prices fell", hook: "Again.", body: "Prices fell.", url: "https://news.example.com/prices", references: [{ label: "Same page", url: "https://news.example.com/ohio", kind: "reference" }] },
		],
		testEmail: "editor@example.net",
		checks: [
			{ id: "numbers", status: "pass", message: "Every number is in a cited page" },
			{ id: "links", status: "warning", message: "One link answered slowly" },
		],
		costUsd: 0.0042,
		thin: true,
		heldReason: "review_mode",
		discoveryNotes: [{ provider: "tinyfish", problem: "Hourly limit reached", scope: "hour", until: "2026-10-28T06:00:00.000Z" }],
		translations: [{ language: "fr", markdown: "# Cette semaine\n\nUne usine a ouvert dans l'Ohio." }, { language: "xx", markdown: "ignored" }],
		...overrides,
	};
}

before(async () => {
	app = await startTestApp(QSTASH_KEYS);
	m = await loadSendingModules();
	delivery = await import("../lib/briefings-delivery.js");
	ContentItem = (await import("../models/ContentItem.js")).default;
	IssueTranslation = (await import("../models/IssueTranslation.js")).default;
	user = await setupSender(m, "briefing-owner@example.com", { contacts: 3 });
	// The test address has to be the owner's or a team member's (create_briefing checks it, and delivery again).
	await (await import("../models/TeamSeat.js")).default.create({ accountId: user.accountId, email: "editor@example.net", role: "editor", status: "active" });
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
		assert.match(notes[0].text, /Kept as a draft for your review\./);
		assert.match(notes[0].text, /This run was thin/);
		assert.match(notes[0].text, /tinyfish: Hourly limit reached \(until 2026-10-28 06:00 UTC\)/);
		assert.match(notes[0].text, /Prices fell \(brief\) \(press release\)/);
	});

	test("the note has a keep and a drop link per story, plain links to the confirmation page, never through click tracking", async () => {
		const { verifyVerdictToken } = await import("../lib/briefing-verdict-links.js");
		const [note] = platformEmails.slice(notesBefore).filter(({ subject }) => /briefing draft is ready/.test(subject));
		const links = [...note.text.matchAll(/^(Keep|Drop): (\S+)$/gm)].map(([, word, url]) => ({ word, url }));
		assert.equal(links.length, 4);
		assert.equal(note.html, undefined, "a text email: nothing to rewrite");
		for (const { word, url } of links) {
			assert.ok(url.startsWith("http://localhost:3000/briefing-verdict/"), url);
			assert.doesNotMatch(url, /\/c\/|\/o\//);
			const link = verifyVerdictToken(url.split("/").at(-1));
			assert.deepEqual([link.runId, link.verdict, link.accountId], [payload().runId, word.toLowerCase(), String(user.accountId)]);
		}
		assert.deepEqual(links.map(({ url }) => verifyVerdictToken(url.split("/").at(-1)).storyKey), ["a".repeat(64), "a".repeat(64), "b".repeat(64), "b".repeat(64)]);
		assert.equal(new Set(links.map(({ url }) => verifyVerdictToken(url.split("/").at(-1)).linkId)).size, 4, "each link has its own id");
	});

	test("keeps the translations against the draft, as plain text from the briefing, and only for readers' languages", async () => {
		const rows = await IssueTranslation.find({ accountId: user.accountId, campaignId: first.campaignId }).lean();
		assert.deepEqual(rows.map(({ language, model }) => [language, model]), [["fr", "briefing"]]);
		assert.match(rows[0].text, /^Cette semaine\s+Une usine a ouvert dans l'Ohio\.$/);
		assert.match(rows[0].sourceHash, /^briefing:[a-f0-9]{64}$/);
		assert.ok(rows[0].expiresAt > new Date(Date.now() + 365 * 86_400_000), "not the reader cache's 7 days");
		assert.equal((await m.Campaign.findOne({ accountId: user.accountId, _id: first.campaignId }).lean()).status, "draft", "delivery never sends");
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

	test("the pacing counters of search keys go after 2 days", async () => {
		const DiscoveryUsage = (await import("../models/DiscoveryUsage.js")).default;
		const { runAgentHousekeeping } = await import("../lib/agent-housekeeping.js");
		const now = Date.now();
		const scope = { accountId: user.accountId, provider: "tinyfish", keyId: "6650f1c2e9b1d4a0123456ee", operation: "search", window: "hour", count: 3 };
		await DiscoveryUsage.create({ ...scope, windowStart: new Date(now - 3 * 86_400_000) });
		await DiscoveryUsage.create({ ...scope, windowStart: new Date(now - 3_600_000) });
		const result = await runAgentHousekeeping(new Date(now));
		assert.equal(result.discoveryUsageDeleted, 1);
		assert.equal(await DiscoveryUsage.countDocuments({ accountId: user.accountId }), 1);
	});
});

describe("a briefing's translation for readers", () => {
	test("a reader who may read the whole issue gets the briefing's own translation, labelled beta, until the owner edits the issue", async () => {
		const { setAi } = await import("./stubs/opennext-cloudflare.mjs");
		const Newsletter = (await import("../models/Newsletter.js")).default;
		const session = await import("../lib/reader-session.js");
		const route = await import("../app/api/reader-translation/route.js");
		await Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { archiveEnabled: true, readerTranslations: true } });
		const newsletter = await Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
		const contact = await m.Contact.create({ accountId: user.accountId, newsletterId: user.newsletterId, email: "translated-reader@example.org", status: "active" });
		const reader = { jar: new Map(), ip: "198.51.100.77" };
		await as(reader, () => session.startReaderSession(newsletter, contact._id));
		const { campaignId } = await delivery.deliverIssue(payload({ slot: "2026-11-05", runId: "6650f1c2e9b1d4a0123456ef" }));
		await m.Campaign.updateOne({ accountId: user.accountId, _id: campaignId }, { $set: { status: "sent", archiveSlug: "briefing-translated" } });
		const ask = async (language) => {
			const request = new Request("http://localhost:3000/api/reader-translation", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000" }, body: JSON.stringify({ slug: newsletter.slug, post: "briefing-translated", language }) });
			const response = await as(reader, () => route.POST(request));
			return { status: response.status, body: await response.json() };
		};
		let calls = 0;
		setAi({ async run() { calls += 1; return { response: "Traduit à la demande\n[END_TRANSLATION]" }; } });
		try {
			const ready = await ask("fr");
			assert.equal(ready.status, 200, JSON.stringify(ready.body));
			assert.deepEqual([ready.body.beta, calls], [true, 0], "no model call: the briefing wrote it");
			assert.match(ready.body.text, /Une usine a ouvert/);
			assert.notEqual((await ask("es")).body.beta, true, "a language the briefing didn't write goes to the model");
			await m.Campaign.updateOne({ accountId: user.accountId, _id: campaignId }, { $set: { audience: "paid" } });
			assert.notEqual((await ask("fr")).body.beta, true, "a reader who sees only part of a paid issue never gets the whole translation");
			await m.Campaign.updateOne({ accountId: user.accountId, _id: campaignId }, { $unset: { audience: 1 } });
			assert.equal((await ask("fr")).body.beta, true);
			await m.Campaign.updateOne({ accountId: user.accountId, _id: campaignId }, { $set: { markdown: "# Edited by the owner" } });
			const edited = await ask("fr");
			assert.equal(edited.body.beta, undefined);
			assert.match(edited.body.text, /Traduit à la demande/, "an edited issue falls back to translation on request");
		} finally {
			setAi(null);
		}
	});
});

describe("the safety review", () => {
	test("the note's keep and drop links are emailed but never logged", async () => {
		const lines = [];
		const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
		for (const level of Object.keys(original)) console[level] = (...args) => lines.push(args.map(String).join(" "));
		const before = platformEmails.length;
		try {
			await delivery.deliverIssue(payload({ slot: "2026-11-10", runId: "6650f1c2e9b1d4a0123457a1" }));
		} finally {
			Object.assign(console, original);
		}
		const note = platformEmails.slice(before).find(({ subject }) => /briefing draft is ready/.test(subject));
		const tokens = [...note.text.matchAll(/\/briefing-verdict\/(\S+)$/gm)].map(([, token]) => token);
		assert.equal(tokens.length, 4, "the email has them");
		const logged = lines.join("\n");
		assert.match(logged, /A briefing draft is ready to review/, "the alert is still logged");
		assert.doesNotMatch(logged, /briefing-verdict/);
		for (const token of tokens) {
			assert.ok(!logged.includes(token), "a verdict token in the logs");
			assert.ok(!logged.includes(token.split(".")[1]), "a verdict signature in the logs");
		}
	});

	test("a test address that is no longer the owner's or a team member's gets nothing: the test goes to the owner, and the note says so", async () => {
		const sentBefore = sent.length;
		const notesBefore = platformEmails.length;
		await delivery.deliverIssue(payload({ slot: "2026-11-11", runId: "6650f1c2e9b1d4a0123457a2", testEmail: "left-the-team@example.org" }));
		assert.deepEqual(sent.slice(sentBefore).map(({ to }) => to), ["briefing-owner@example.com"]);
		const note = platformEmails.slice(notesBefore).find(({ subject }) => /briefing draft is ready/.test(subject));
		assert.match(note.text, /left-the-team@example\.org is no longer you or a member of your team, so the test email went to briefing-owner@example\.com instead\./);
		assert.match(note.text, /A test email went to briefing-owner@example\.com\./);
	});
});

describe("sections", () => {
	test("the owner's note lists each section's cost and which were empty, skipped or failed, and the draft is the engine's Markdown as is", async () => {
		const before = platformEmails.length;
		const markdown = "## Lead\n\nA plant opened in Ohio ([1](https://news.example.com/ohio)).\n\n## Deal flow\n\n- **Acme** raised $5M ([2](https://news.example.com/acme))";
		const { campaignId } = await delivery.deliverIssue(payload({
			slot: "2026-11-12",
			runId: "6650f1c2e9b1d4a0123457b1",
			markdown,
			sections: [
				{ id: "lead", title: "Lead", status: "written", items: 1, costUsd: 0.0021 },
				{ id: "deal-flow", title: "Deal flow", status: "written", items: 3, costUsd: 0.0012 },
				{ id: "people", title: "People moves", status: "empty", items: 0, costUsd: 0 },
				{ id: "coming-up", title: "Coming up", status: "skipped_budget", items: 0, costUsd: 0.0003 },
				{ id: "launches", title: "Launches", status: "failed", items: 0, costUsd: 0.0001, problem: "The write model answered nothing" },
			],
		}));
		assert.equal((await m.Campaign.findOne({ accountId: user.accountId, _id: campaignId }).lean()).markdown, markdown);
		const note = platformEmails.slice(before).find(({ subject }) => /briefing draft is ready/.test(subject));
		assert.match(note.text, /Sections:\n- Lead: 1 story, \$0\.0021\n- Deal flow: 3 stories, \$0\.0012\n- People moves: empty: no story for it, so it isn't in the issue, \$0\.0000\n- Coming up: skipped: its share of the budget ran out, \$0\.0003\n- Launches: failed, \$0\.0001 \(The write model answered nothing\)/);
		assert.match(note.text, /Model cost of this run/);
		assert.equal(delivery.describeSections([]).length, 0, "an unsectioned run has no section lines");
	});
});

