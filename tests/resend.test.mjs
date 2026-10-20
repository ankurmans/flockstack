import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startTestApp } from "./helpers/app.mjs";
import { QSTASH_KEYS, act, createDraft, loadSendingModules, runJobs, sendRoutes, setupSender } from "./helpers/sending.mjs";
import { published } from "./stubs/qstash.mjs";
import { sent } from "./stubs/ses.mjs";

// Resending to readers who didn't open (beehiiv parity S21): a scheduled copy with its own subject, for the readers the
// first send reached who didn't open it, or didn't click, once per campaign.

describe("a resend", () => {
	let app;
	let m;

	before(async () => {
		app = await startTestApp(QSTASH_KEYS);
		m = { ...(await loadSendingModules()), emailEvents: await import("../lib/email-events.js") };
	});

	after(() => app?.stop());

	const campaignOf = (user, id) => m.Campaign.findOne({ accountId: user.accountId, _id: id }).lean();
	const toReaders = (user, subject) => sent.filter(({ to, subject: one }) => to.endsWith(`@${user.slug}.example.org`) && one === subject).map(({ to }) => to).sort();

	async function engage(user, campaignId, email, type) {
		const message = await m.Message.findOne({ accountId: user.accountId, campaignId, email }).lean();
		await m.Message.updateOne({ accountId: user.accountId, _id: message._id }, { $set: { sentAt: new Date(Date.now() - 600_000) } });
		await m.emailEvents.recordEngagement({ message: await m.emailEvents.findTrackedMessage(message._id), type, userAgent: "Mozilla/5.0 Chrome/141.0" });
	}

	async function sendIssue(email, subject) {
		const user = await setupSender(m, email, { contacts: 8 });
		user.slug = email.split("@")[0];
		const campaignId = await createDraft(m, user, { subject, body: '<p><a href="https://example.org/">Read</a></p>' });
		await act(m, user, "send_campaign", { id: campaignId });
		await runJobs(sendRoutes(m));
		const reader = (index) => `reader${index}@${user.slug}.example.org`;
		await engage(user, campaignId, reader(0), "Open");
		await engage(user, campaignId, reader(1), "Open");
		await engage(user, campaignId, reader(2), "Click");
		await m.Message.updateOne({ accountId: user.accountId, campaignId, email: reader(3) }, { $set: { status: "bounced", bouncedAt: new Date() } });
		await m.Contact.updateOne({ accountId: user.accountId, email: reader(4) }, { $set: { status: "unsubscribed" } });
		return { user, campaignId, reader };
	}

	test("goes to readers who didn't open, a day after the first send by default, once", async () => {
		const { user, campaignId, reader } = await sendIssue("resend-open@example.com", "First try");
		const original = await campaignOf(user, campaignId);
		const resend = await act(m, user, "resend_campaign", { id: campaignId, subject: "Missed this?" });
		assert.equal(resend.status, "scheduled");
		assert.deepEqual(resend.resend, { of: campaignId, to: "unopened" });
		assert.equal(new Date(resend.scheduledAt).getTime(), new Date(original.sentAt).getTime() + 24 * 3_600_000);
		const job = published.findLast(({ url }) => url.endsWith("/api/jobs/send-scheduled"));
		assert.equal(job.body.campaignId, resend.id);
		assert.equal((await campaignOf(user, campaignId)).resentAs.toString(), resend.id);

		await assert.rejects(act(m, user, "resend_campaign", { id: campaignId, subject: "Again" }), { code: "conflict" });
		await assert.rejects(act(m, user, "resend_campaign", { id: resend.id, subject: "Again" }), { code: "conflict" });

		const usedBefore = (await m.Account.findById(user.accountId).lean()).usage.emailsSent;
		await act(m, user, "send_campaign", { id: resend.id });
		await runJobs(sendRoutes(m));
		assert.deepEqual(toReaders(user, "Missed this?"), [5, 6, 7].map(reader), "not the openers, the bounced address or the unsubscribed reader");
		assert.equal((await m.Account.findById(user.accountId).lean()).usage.emailsSent, usedBefore + 3, "it counts toward the plan");
		const copy = await campaignOf(user, resend.id);
		assert.equal(copy.status, "sent");
		assert.equal(copy.html, original.html);
		assert.equal(copy.archiveSlug, undefined, "no page of its own");
	});

	test("can go to readers who didn't click instead, at a time of the owner's choosing", async () => {
		const { user, campaignId, reader } = await sendIssue("resend-click@example.com", "Second try");
		const at = new Date(Date.now() + 2 * 3_600_000).toISOString();
		const resend = await act(m, user, "resend_campaign", { id: campaignId, subject: "Take a look", to: "unclicked", scheduledAt: at });
		assert.equal(resend.scheduledAt, at);
		await act(m, user, "send_campaign", { id: resend.id });
		await runJobs(sendRoutes(m));
		assert.deepEqual(toReaders(user, "Take a look"), [0, 1, 5, 6, 7].map(reader), "openers who didn't click are in");
	});

	test("a discarded resend frees its campaign; drafts and past times are refused", async () => {
		const { user, campaignId } = await sendIssue("resend-discard@example.com", "Third try");
		const resend = await act(m, user, "resend_campaign", { id: campaignId, subject: "Once more" });
		await act(m, user, "unschedule_campaign", { id: resend.id });
		await act(m, user, "delete_campaign", { id: resend.id });
		assert.equal((await campaignOf(user, campaignId)).resentAs, undefined);
		await assert.rejects(
			act(m, user, "resend_campaign", { id: campaignId, subject: "Once more", scheduledAt: new Date(Date.now() - 60_000).toISOString() }),
			{ code: "validation_failed" }
		);
		assert.equal((await act(m, user, "resend_campaign", { id: campaignId, subject: "Once more" })).status, "scheduled");

		const draft = await createDraft(m, user, { subject: "Not sent" });
		await assert.rejects(act(m, user, "resend_campaign", { id: draft, subject: "Nope" }), { code: "conflict" });
	});
});
