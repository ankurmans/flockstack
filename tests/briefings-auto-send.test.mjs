import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, describe, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { anonymous, as, catchRedirect, form, platformEmails, startTestApp } from "./helpers/app.mjs";
import { QSTASH_KEYS, loadSendingModules, setupSender } from "./helpers/sending.mjs";

// Briefings sending by itself (docs/BRIEFINGS-DESIGN.md, Auto-send): lib/briefings-delivery.js sends a run's issue through
// send_campaign only when every condition holds, and leaves a draft with the reason (heldReason) and a note to the owner when one
// does not. A run reaches delivery already judged by the engine (thin, unfinished steps and failed checks arrive as payload.heldReason);
// delivery reads the briefing, the plan, the newsletter and the ready-to-send check again.
let app;
let m;
let delivery;
let owner;
let Briefing;
let BriefingRun;
let ApprovalRequest;
let pauseLinks;

const hex = () => crypto.randomBytes(12).toString("hex");
const SENT = ["sending", "sent"];

// A briefing in send mode with a run, and the payload the engine hands delivery for a clean run. Each scenario has its own briefing,
// so the daily cap of one does not count another's sends.
async function scenario({ briefing = {}, run = {}, payload = {} } = {}) {
	const briefingId = hex();
	const runId = hex();
	await Briefing.create({ _id: briefingId, accountId: owner.accountId, newsletterId: owner.newsletterId, name: "Daily batteries", status: "active", reviewMode: "send_if_checks_pass", autoSendDailyCap: 1, ...briefing });
	await BriefingRun.create({ _id: runId, accountId: owner.accountId, briefingId, newsletterId: owner.newsletterId, slot: "2026-11-02", ...run });
	return {
		briefingId,
		runId,
		payload: {
			accountId: String(owner.accountId),
			newsletterId: String(owner.newsletterId),
			briefingId,
			runId,
			slot: "2026-11-02",
			subject: "Batteries today",
			previewText: "A short note",
			markdown: "A plant opened in Ohio and it makes cells.",
			stories: [{ storyKey: "a".repeat(64), kind: "full", sourceKind: "reporting", externalId: `briefing:${briefingId}:aaa`, title: "A plant opened in Ohio", hook: "It makes cells.", body: "The plant makes cells.", url: "https://news.example.com/ohio", references: [] }],
			testEmail: owner.email,
			checks: [{ id: "numbers", status: "pass", message: "Every number is in a cited page" }],
			costUsd: 0.01,
			thin: false,
			heldReason: null,
			reviewMode: "send_if_checks_pass",
			discoveryNotes: [],
			translations: [],
			...payload,
		},
	};
}

const campaignOf = (id) => m.Campaign.findOne({ accountId: owner.accountId, _id: id }).lean();
const notesSince = (count) => platformEmails.slice(count).filter(({ subject }) => /briefing issue|briefing draft/i.test(subject));

async function deliver(setup) {
	const before = platformEmails.length;
	const result = await delivery.deliverIssue(setup.payload);
	const [note] = notesSince(before);
	return { result, note, campaign: await campaignOf(result.campaignId), run: await BriefingRun.findOne({ accountId: owner.accountId, _id: setup.runId }).lean() };
}

before(async () => {
	app = await startTestApp(QSTASH_KEYS);
	m = { ...(await loadSendingModules()), approvals: await import("../app/(app)/approvals/actions.js"), pausePage: await import("../app/briefing-pause/[token]/page.js"), pauseActions: await import("../app/briefing-pause/actions.js") };
	delivery = await import("../lib/briefings-delivery.js");
	pauseLinks = await import("../lib/briefing-pause-links.js");
	Briefing = (await import("../models/Briefing.js")).default;
	BriefingRun = (await import("../models/BriefingRun.js")).default;
	ApprovalRequest = (await import("../models/ApprovalRequest.js")).default;
	owner = await setupSender(m, "autosend-owner@example.com", { contacts: 3 });
});

after(() => app?.stop());

describe("a run that passes everything", () => {
	test("is queued for sending to the audience through send_campaign, counted against the daily cap, and the owner is told with a pause link", async () => {
		const setup = await scenario();
		const { result, note, campaign, run } = await deliver(setup);
		assert.equal(result.status, "sent");
		assert.equal(result.heldReason, undefined);
		assert.ok(SENT.includes(campaign.status), campaign.status);
		assert.ok(campaign.testSentAt, "the test email still goes to the test address");
		assert.ok(run.autoSentAt, "the run records the send, which the cap counts");
		assert.match(note.subject, /A briefing issue was sent/);
		assert.match(note.text, /Sent to your audience by itself, because every check passed/);
		assert.doesNotMatch(note.text, /Kept as a draft/);
		const [, url] = note.text.match(/^(http\S+\/briefing-pause\/\S+)$/m);
		assert.ok(!url.includes("/c/") && !url.includes("/o/"), "a plain link, never through click tracking");
		const link = pauseLinks.verifyPauseToken(url.split("/").at(-1));
		assert.deepEqual([link.briefingId, link.runId, link.accountId], [setup.briefingId, setup.runId, String(owner.accountId)]);
		assert.ok(!JSON.stringify(await m.Campaign.find({ accountId: owner.accountId }).lean()).includes("briefing-pause"), "the link is in the note, not the issue");
	});

	test("asking again after the send finds it sent and sends nothing twice", async () => {
		const setup = await scenario();
		const first = await deliver(setup);
		const emails = platformEmails.length;
		const again = await delivery.deliverIssue(setup.payload);
		assert.deepEqual([again.status, again.campaignId], ["sent", first.result.campaignId]);
		assert.equal(await m.Campaign.countDocuments({ accountId: owner.accountId, externalId: `briefing:${setup.briefingId}:2026-11-02` }), 1);
		assert.equal(platformEmails.length, emails, "the owner is not told twice");
	});

	test("the pause link opens a page that pauses nothing until its button is pressed, and then pauses the briefing", async () => {
		const setup = await scenario();
		const { note } = await deliver(setup);
		const [, url] = note.text.match(/^(http\S+\/briefing-pause\/\S+)$/m);
		const token = url.split("/").at(-1);
		const render = async () => anonymous(async () => renderToStaticMarkup(await m.pausePage.default({ params: Promise.resolve({ token }), searchParams: Promise.resolve({}) })));
		assert.match(await render(), /Pause this briefing\?/);
		assert.equal((await Briefing.findOne({ accountId: owner.accountId, _id: setup.briefingId }).lean()).status, "active", "opening it paused nothing");
		const pressed = await anonymous(() => catchRedirect(m.pauseActions.confirmPause(form({ token }))));
		assert.equal(pressed, `/briefing-pause/${token}?result=paused`);
		const paused = await Briefing.findOne({ accountId: owner.accountId, _id: setup.briefingId }).lean();
		assert.equal(paused.status, "paused");
		assert.equal(paused.nextRunAt, undefined);
		assert.match(await render(), /Already paused/);
		assert.equal(await anonymous(() => catchRedirect(m.pauseActions.confirmPause(form({ token: "nope" })))), "/briefing-pause/nope");
		assert.match(await anonymous(async () => renderToStaticMarkup(await m.pausePage.default({ params: Promise.resolve({ token: "%zz" }), searchParams: Promise.resolve({}) }))), /This link doesn&#x27;t work/);
	});

	test("pause links are signed for this purpose, expire after 14 days and are not verdict links", async () => {
		const ids = { accountId: hex(), briefingId: hex(), runId: hex() };
		const now = Date.now();
		const token = pauseLinks.createPauseToken(ids, now);
		assert.deepEqual(pauseLinks.verifyPauseToken(token, now + 13 * 86_400_000) && { ...pauseLinks.verifyPauseToken(token, now) }.briefingId, ids.briefingId);
		assert.equal(pauseLinks.verifyPauseToken(token, now + 15 * 86_400_000), null);
		assert.equal(pauseLinks.verifyPauseToken(`${token.slice(0, -2)}xx`), null);
		const verdict = (await import("../lib/briefing-verdict-links.js")).createVerdictToken({ accountId: ids.accountId, runId: ids.runId, storyKey: "a".repeat(10), verdict: "keep" });
		assert.equal(pauseLinks.verifyPauseToken(verdict), null);
		assert.throws(() => pauseLinks.createPauseToken({ ...ids, briefingId: "x" }), /pause link needs/);
	});
});

describe("a run that is held as a draft", () => {
	async function assertHeld(setup, reason, pattern) {
		const { result, note, campaign, run } = await deliver(setup);
		assert.deepEqual([result.status, result.heldReason], ["drafted", reason]);
		assert.equal(campaign.status, "draft", "nothing is queued");
		assert.equal(run.autoSentAt, undefined);
		assert.match(note.subject, /A briefing draft is ready to review|waiting for your approval/);
		if (pattern) assert.match(note.text, pattern);
		assert.doesNotMatch(note.text, /briefing-pause/);
		return { result, note, campaign };
	}

	test("review_mode: the briefing keeps drafts", async () => {
		const { note } = await assertHeld(await scenario({ payload: { reviewMode: "draft", heldReason: "review_mode" } }), "review_mode", /Kept as a draft for your review/);
		assert.ok(note);
	});

	test("review_mode: sending by itself was turned off, or the briefing paused, while the run was going", async () => {
		await assertHeld(await scenario({ briefing: { reviewMode: "draft" } }), "review_mode", /turned off, or the briefing paused/);
		await assertHeld(await scenario({ briefing: { status: "paused" } }), "review_mode", /turned off, or the briefing paused/);
	});

	test("review_mode: a run started by hand is always a draft", async () => {
		await assertHeld(await scenario({ payload: { slot: "manual:2026-11-02T08:00:00.000Z" } }), "review_mode", /you start by hand is always kept as a draft/);
	});

	test("review_mode: the Free plan never sends by itself", async () => {
		const free = await setupSender(m, "autosend-free@example.com", { contacts: 2 });
		await m.Account.updateOne({ _id: free.accountId }, { $set: { subscriptionStatus: "canceled" } });
		const briefingId = hex();
		const runId = hex();
		await Briefing.create({ _id: briefingId, accountId: free.accountId, newsletterId: free.newsletterId, name: "Free daily", status: "active", reviewMode: "send_if_checks_pass" });
		await BriefingRun.create({ _id: runId, accountId: free.accountId, briefingId, newsletterId: free.newsletterId, slot: "2026-11-02" });
		const { payload } = await scenario();
		const result = await delivery.deliverIssue({ ...payload, accountId: String(free.accountId), newsletterId: String(free.newsletterId), briefingId, runId, testEmail: free.email });
		assert.deepEqual([result.status, result.heldReason], ["drafted", "review_mode"]);
		assert.equal((await m.Campaign.findOne({ accountId: free.accountId, _id: result.campaignId }).lean()).status, "draft");
	});

	test("thin, partial and checks from the engine arrive as the run's own reason and are never sent", async () => {
		for (const [reason, pattern] of [["thin", /discovery found less than usual/], ["partial", /part of the run did not finish/], ["checks", /a check did not pass/]]) {
			await assertHeld(await scenario({ payload: { heldReason: reason, thin: reason === "thin" } }), reason, pattern);
		}
	});

	test("checks: the ready-to-send check's warning holds it, and the note names it", async () => {
		const subject = "Batteries today: a plant opened in Ohio, prices fell again and a long subject keeps going";
		const { note } = await assertHeld(await scenario({ payload: { subject } }), "checks", /Kept as a draft: a check did not pass\./);
		assert.match(note.text, /- Subject: .*characters/);
	});

	test("checks: the claim check holds an issue with a figure and no source", async () => {
		const { note } = await assertHeld(await scenario({ payload: { markdown: "Prices fell 12% in a year." } }), "checks", /Claim check|claim check|figure/i);
		assert.ok(note);
	});

	test("checks: links still being read are asked about again; past the wait the issue is held with why", async () => {
		const setup = await scenario({ payload: { markdown: "A plant opened ([report](https://news.example.com/ohio))." } });
		const emails = platformEmails.length;
		const first = await delivery.deliverIssue(setup.payload);
		assert.equal(first.status, "checking");
		assert.equal(platformEmails.length, emails, "no word to the owner while it waits");
		assert.equal((await campaignOf(first.campaignId)).status, "draft");
		const { result, note } = await (async () => {
			const before = platformEmails.length;
			const result = await delivery.deliverIssue({ ...setup.payload, checksTimedOut: true });
			return { result, note: notesSince(before)[0] };
		})();
		assert.deepEqual([result.status, result.heldReason], ["drafted", "checks"]);
		assert.match(note.text, /did not finish in 10 minutes/);
	});

	test("daily_cap: a briefing past its allowance for the UTC day keeps the next one as a draft", async () => {
		const setup = await scenario({ briefing: { autoSendDailyCap: 1 } });
		await BriefingRun.create({ accountId: owner.accountId, briefingId: setup.briefingId, newsletterId: owner.newsletterId, slot: "2026-11-01", status: "sent", autoSentAt: new Date() });
		await assertHeld(setup, "daily_cap", /already went out by itself today \(UTC\), and this briefing's allowance is 1/);
		const roomy = await scenario({ briefing: { autoSendDailyCap: 2 } });
		await BriefingRun.create({ accountId: owner.accountId, briefingId: roomy.briefingId, newsletterId: owner.newsletterId, slot: "2026-11-01", status: "sent", autoSentAt: new Date() });
		assert.equal((await deliver(roomy)).result.status, "sent", "a cap of two has room for a second");
		const yesterday = await scenario();
		await BriefingRun.create({ accountId: owner.accountId, briefingId: yesterday.briefingId, newsletterId: owner.newsletterId, slot: "2026-10-31", status: "sent", autoSentAt: new Date(Date.now() - 36 * 3_600_000) });
		assert.equal((await deliver(yesterday)).result.status, "sent", "yesterday's send does not count");
	});

	test("agent_approval: a newsletter that asks before an agent sends turns the send into an approval request, and approving sends it once", async () => {
		await m.Newsletter.updateOne({ accountId: owner.accountId, _id: owner.newsletterId }, { $set: { agentApproval: true } });
		try {
			const setup = await scenario();
			const { result, note, campaign } = await assertHeld(setup, "agent_approval", /Waiting for your approval/);
			assert.match(note.subject, /waiting for your approval/);
			const [approval] = await ApprovalRequest.find({ accountId: owner.accountId, actorId: `briefing:${setup.briefingId}` }).lean();
			assert.deepEqual([approval.status, approval.action, approval.className, approval.reason, approval.via, approval.actorType], ["pending", "send_campaign", "send", "newsletter", "briefing", "app"]);
			assert.deepEqual(approval.input, { id: result.campaignId });
			assert.equal(campaign.status, "draft");
			// Asked again (a retried delivery): the same request, not a second.
			await delivery.deliverIssue(setup.payload);
			assert.equal(await ApprovalRequest.countDocuments({ accountId: owner.accountId, actorId: `briefing:${setup.briefingId}` }), 1);
			const decided = await as(owner, () => m.approvals.decideApproval(String(approval._id), "approve"));
			assert.equal(decided.approval.executed, true, JSON.stringify(decided));
			assert.ok(SENT.includes((await campaignOf(result.campaignId)).status));
			// A briefing deleted before the owner answers cannot send.
			const gone = await scenario();
			await delivery.deliverIssue(gone.payload);
			await Briefing.deleteOne({ accountId: owner.accountId, _id: gone.briefingId });
			const [pending] = await ApprovalRequest.find({ accountId: owner.accountId, actorId: `briefing:${gone.briefingId}` }).lean();
			const refused = await as(owner, () => m.approvals.decideApproval(String(pending._id), "approve"));
			assert.equal(refused.approval.executed, false);
			assert.equal(refused.approval.execution.error.code, "unauthorized");
		} finally {
			await m.Newsletter.updateOne({ accountId: owner.accountId, _id: owner.newsletterId }, { $unset: { agentApproval: 1 } });
		}
	});

	test("a send that the normal path refuses is a draft with its words, not an error", async () => {
		const setup = await scenario();
		await m.Account.updateOne({ _id: owner.accountId }, { $set: { "usage.emailsSent": 99_999 } });
		try {
			const { note } = await assertHeld(setup, "checks", /Kept as a draft: a check did not pass/);
			assert.match(note.text, /Plan|plan|emails/);
		} finally {
			await m.Account.updateOne({ _id: owner.accountId }, { $set: { "usage.emailsSent": 0 } });
		}
	});
});
