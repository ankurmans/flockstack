import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { as, startTestApp } from "./helpers/app.mjs";
import { QSTASH_KEYS, act, createDraft, loadSendingModules, runJobs, sendRoutes, setupSender } from "./helpers/sending.mjs";
import { orderByCohort } from "../lib/cohort-order.js";
import { sent } from "./stubs/ses.mjs";

// Random cohort sends (parity item S8): a limit that takes a random share of the audience instead of the most engaged,
// fair, the same in every step, and safe to run twice.
let app;
let m;

before(async () => {
	app = await startTestApp(QSTASH_KEYS);
	m = await loadSendingModules();
});

after(() => app?.stop());

const READERS = 60;

async function recipientsOf(user, campaignId) {
	const messages = await m.Message.find({ accountId: user.accountId, campaignId, kind: "campaign" }).lean();
	return messages.map(({ email }) => email);
}

// reader0 is the most engaged, reader59 the least: the position in this list is the engagement rank.
const rank = (email) => Number(/^reader(\d+)@/.exec(email)[1]);

describe("a random cohort", () => {
	test("takes the lowest ranks of the campaign's own order, not the most engaged, and each contact gets one email", async () => {
		const user = await setupSender(m, "cohort-first@example.com", { contacts: READERS });
		const id = await createDraft(m, user, { subject: "Random first" });
		const result = await act(m, user, "send_campaign", { id, audienceLimit: 12, audienceOrder: "random" });
		assert.equal(result.audienceOrder, "random");
		assert.equal(result.audienceLimit, 12);
		await runJobs(sendRoutes(m));

		const everyone = (await m.Contact.find({ accountId: user.accountId, newsletterId: user.newsletterId }).lean()).map(({ _id }) => String(_id));
		const expected = new Set(orderByCohort(id, everyone).slice(0, 12));
		const messages = await m.Message.find({ accountId: user.accountId, campaignId: id, kind: "campaign" }).lean();
		assert.equal(messages.length, 12);
		assert.deepEqual(new Set(messages.map(({ contactId }) => String(contactId))), expected, "exactly the cohort the order gives");

		const emails = messages.map(({ email }) => email);
		assert.notDeepEqual(emails.toSorted(), Array.from({ length: 12 }, (_, index) => `reader${index}@cohort-first.example.org`).toSorted(), "not the 12 most engaged");
		assert.ok(emails.some((email) => rank(email) >= READERS / 2), "the least engaged half can be in it too");
		const delivered = sent.filter(({ to }) => to.endsWith("@cohort-first.example.org"));
		assert.equal(delivered.length, 12);
		assert.equal(new Set(delivered.map(({ to }) => to)).size, 12, "one email each");
	});

	test("without audienceOrder the most engaged still go first", async () => {
		const user = await setupSender(m, "cohort-default@example.com", { contacts: READERS });
		const id = await createDraft(m, user);
		const result = await act(m, user, "send_campaign", { id, audienceLimit: 5 });
		assert.equal(result.audienceOrder, "engaged");
		await runJobs(sendRoutes(m));
		assert.deepEqual((await recipientsOf(user, id)).map(rank).toSorted((a, b) => a - b), [0, 1, 2, 3, 4]);
	});

	test("send_campaign_to_more continues the same order: the next step adds the next ranks and nobody twice", async () => {
		const user = await setupSender(m, "cohort-steps@example.com", { contacts: READERS });
		const id = await createDraft(m, user, { subject: "In steps" });
		await act(m, user, "send_campaign", { id, audienceLimit: 10, audienceOrder: "random" });
		await runJobs(sendRoutes(m));
		const firstStep = new Set(await recipientsOf(user, id));
		assert.equal(firstStep.size, 10);

		const more = await act(m, user, "send_campaign_to_more", { id, additional: 15 });
		assert.equal(more.audienceOrder, "random", "the campaign keeps its order");
		await runJobs(sendRoutes(m));
		const secondStep = await recipientsOf(user, id);
		assert.equal(secondStep.length, 25);
		assert.equal(new Set(secondStep).size, 25, "nobody twice");
		for (const email of firstStep) assert.ok(secondStep.includes(email), "the first step's cohort is inside the second");

		const everyone = (await m.Contact.find({ accountId: user.accountId, newsletterId: user.newsletterId }).lean()).map(({ _id }) => String(_id));
		const expected = new Set(orderByCohort(id, everyone).slice(0, 25));
		const stored = await m.Message.find({ accountId: user.accountId, campaignId: id, kind: "campaign" }).lean();
		assert.deepEqual(new Set(stored.map(({ contactId }) => String(contactId))), expected, "the first 25 ranks");
		const delivered = sent.filter(({ to }) => to.endsWith("@cohort-steps.example.org"));
		assert.equal(delivered.length, 25);
		assert.equal(new Set(delivered.map(({ to }) => to)).size, 25);

		await act(m, user, "send_campaign_to_more", { id });
		await runJobs(sendRoutes(m));
		assert.equal((await recipientsOf(user, id)).length, READERS, "the rest follow");
		assert.equal(new Set(sent.filter(({ to }) => to.endsWith("@cohort-steps.example.org")).map(({ to }) => to)).size, READERS);
	});

	test("queueing again after a stop halfway reaches the same contacts and adds nobody", async () => {
		const user = await setupSender(m, "cohort-retry@example.com", { contacts: READERS });
		const id = await createDraft(m, user, { subject: "Retried" });
		await act(m, user, "send_campaign", { id, audienceLimit: 20, audienceOrder: "random" });
		const before = (await recipientsOf(user, id)).toSorted();
		// The campaign went back to a draft as if queueing stopped before it was marked sending; sending it again repeats the selection.
		await m.Campaign.updateOne({ accountId: user.accountId, _id: id }, { $set: { status: "draft" } });
		await act(m, user, "send_campaign", { id, audienceLimit: 20, audienceOrder: "random" });
		assert.deepEqual((await recipientsOf(user, id)).toSorted(), before);
		await runJobs(sendRoutes(m));
		assert.equal(new Set(sent.filter(({ to }) => to.endsWith("@cohort-retry.example.org")).map(({ to }) => to)).size, 20);
	});

	test("two campaigns take different cohorts from the same list", async () => {
		const user = await setupSender(m, "cohort-two@example.com", { contacts: READERS });
		const first = await createDraft(m, user, { subject: "One" });
		const second = await createDraft(m, user, { subject: "Two" });
		await act(m, user, "send_campaign", { id: first, audienceLimit: 20, audienceOrder: "random" });
		await act(m, user, "send_campaign", { id: second, audienceLimit: 20, audienceOrder: "random" });
		assert.notDeepEqual((await recipientsOf(user, first)).toSorted(), (await recipientsOf(user, second)).toSorted());
	});

	test("only counts active contacts, leaves out suppressed addresses and respects the audience", async () => {
		const user = await setupSender(m, "cohort-filter@example.com", { contacts: 30 });
		await m.Contact.updateMany({ accountId: user.accountId, email: { $in: Array.from({ length: 10 }, (_, index) => `reader${index}@cohort-filter.example.org`) } }, { $set: { status: "unsubscribed" } });
		const Suppression = (await import("../models/Suppression.js")).default;
		await Suppression.create({ accountId: user.accountId, email: "reader10@cohort-filter.example.org", reason: "bounce" });
		const id = await createDraft(m, user);
		await act(m, user, "send_campaign", { id, audienceLimit: 100, audienceOrder: "random" });
		const emails = await recipientsOf(user, id);
		assert.equal(emails.length, 19, "30 minus 10 unsubscribed minus 1 suppressed");
		assert.ok(!emails.includes("reader10@cohort-filter.example.org"));
		assert.ok(emails.every((email) => rank(email) >= 11));
	});

	test("works with the list cleanup on: the limit counts issue recipients and cold contacts in the cohort get the last-chance email", async () => {
		const user = await setupSender(m, "cohort-cleanup@example.com", { contacts: READERS });
		await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { cleanup: { enabled: true, issues: 2, days: 30 } } });
		const longAgo = new Date(Date.now() - 400 * 86_400_000);
		const cold = Array.from({ length: 20 }, (_, index) => `reader${READERS - 1 - index}@cohort-cleanup.example.org`);
		await m.Contact.updateMany({ accountId: user.accountId, email: { $in: cold } }, { $set: { ignoredIssues: 5, lastOpenAt: longAgo, createdAt: longAgo, subscribedAt: longAgo } });
		const id = await createDraft(m, user, { subject: "Cleaned" });

		const preview = await act(m, user, "preview_campaign_cleanup", { id, audienceLimit: 15, audienceOrder: "random" });
		await act(m, user, "send_campaign", { id, audienceLimit: 15, audienceOrder: "random" });
		const issues = await m.Message.find({ accountId: user.accountId, campaignId: id, kind: "campaign" }).lean();
		const lastChance = await m.Message.find({ accountId: user.accountId, campaignId: id, kind: "last-chance" }).lean();
		assert.equal(issues.length, 15, "exactly the limit gets the issue");
		assert.ok(issues.every(({ email }) => !cold.includes(email)), "no cold contact gets the issue");
		assert.equal(preview.issue, 15);
		assert.equal(preview.lastChance, lastChance.length, "the preview walked the same random order");
		assert.ok(lastChance.length > 0 && lastChance.length <= 20);
	});
});

describe("the choice", () => {
	test("is kept by a schedule, and cleared by one that doesn't ask for it", async () => {
		const user = await setupSender(m, "cohort-schedule@example.com", { contacts: 10 });
		const id = await createDraft(m, user);
		const at = new Date(Date.now() + 86_400_000).toISOString();
		const scheduled = await act(m, user, "schedule_campaign", { id, scheduledAt: at, audienceLimit: 4, audienceOrder: "random" });
		assert.deepEqual([scheduled.audienceLimit, scheduled.audienceOrder], [4, "random"]);
		const again = await act(m, user, "schedule_campaign", { id, scheduledAt: at, audienceLimit: 4 });
		assert.equal(again.audienceOrder, "engaged");
		assert.equal((await m.Campaign.findOne({ accountId: user.accountId, _id: id }).lean()).audienceOrder, undefined);
	});

	test("goes through the dashboard's held send, and undo gives the draft back without it", async () => {
		const user = await setupSender(m, "cohort-hold@example.com", { contacts: 10 });
		const id = await createDraft(m, user);
		const held = await as(user, () => m.campaigns.startSend(id, { audienceLimit: 3, audienceOrder: "random" }));
		assert.equal(held.status, "held");
		const stored = await m.Campaign.findOne({ accountId: user.accountId, _id: id }).lean();
		assert.deepEqual([stored.audienceLimit, stored.audienceOrder], [3, "random"]);
		assert.deepEqual(await as(user, () => m.campaigns.undoSend(id)), { ok: true });
		const back = await m.Campaign.findOne({ accountId: user.accountId, _id: id }).lean();
		assert.equal(back.status, "draft");
		assert.equal(back.audienceOrder, undefined);
		assert.equal(back.audienceLimit, undefined);
	});

	test("is refused for a value that isn't one of the two", async () => {
		const user = await setupSender(m, "cohort-invalid@example.com", { contacts: 3 });
		const id = await createDraft(m, user);
		await assert.rejects(act(m, user, "send_campaign", { id, audienceLimit: 2, audienceOrder: "newest" }), { code: "validation_failed" });
	});
});
