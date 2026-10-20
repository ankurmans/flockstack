import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { getTestSize, getVariantContent, pickWinner } from "../lib/ab-test-rules.js";
import { startTestApp } from "./helpers/app.mjs";
import { QSTASH_KEYS, act, createDraft, loadSendingModules, runJobs, sendRoutes, setupSender } from "./helpers/sending.mjs";
import { sent } from "./stubs/ses.mjs";
import { published } from "./stubs/qstash.mjs";

// Subject line tests (beehiiv parity S3): the subjects go in turn to a slice of the audience through the usual send, a
// QStash job picks the winner after the wait and sends it to the rest as a send_campaign_to_more step.

const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/141.0 Safari/537.36";
const variant = (sent, opened, clicked) => ({ sent, opened, clicked });

test("the winner has the most unique clicks per email, then opens; opens first when asked", () => {
	assert.equal(pickWinner([variant(10, 5, 1), variant(10, 2, 3), variant(10, 9, 2)]), 1);
	assert.equal(pickWinner([variant(10, 5, 1), variant(10, 2, 3), variant(10, 9, 2)], "opens"), 2);
	assert.equal(pickWinner([variant(10, 5, 2), variant(10, 6, 2)]), 1, "a tie on clicks goes to opens");
	assert.equal(pickWinner([variant(10, 5, 2), variant(10, 5, 2)]), 0, "then to the earlier subject");
	assert.equal(pickWinner([variant(4, 0, 1), variant(5, 0, 1)]), 0, "rates, not counts");
	assert.equal(pickWinner([variant(0, 0, 0), variant(0, 0, 0)]), 0);
});

test("the test slice is its share of the audience, at least one email per subject", () => {
	const variants = [{}, {}, {}];
	assert.equal(getTestSize(1000, { testPercent: 20, variants }), 200);
	assert.equal(getTestSize(7, { testPercent: 20, variants }), 3);
	assert.equal(getTestSize(2, { testPercent: 20, variants }), 2);
	assert.equal(getTestSize(0, { testPercent: 20, variants }), 0);
});

test("each email says its own subject, and the rest the winner's", () => {
	const campaign = { subject: "A", previewText: "pa", abTest: { status: "testing", variants: [{ subject: "A" }, { subject: "B", previewText: "pb" }, { subject: "C" }] } };
	assert.deepEqual([getVariantContent(campaign, 1).subject, getVariantContent(campaign, 1).previewText], ["B", "pb"]);
	assert.deepEqual([getVariantContent(campaign, 2).subject, getVariantContent(campaign, 2).previewText], ["C", "pa"]);
	assert.equal(getVariantContent(campaign, undefined).subject, "A");
	const picked = { ...campaign, abTest: { ...campaign.abTest, status: "picked", winner: 2 } };
	assert.equal(getVariantContent(picked, undefined).subject, "C");
	assert.equal(getVariantContent(picked, 1).subject, "B", "the slice keeps what it got");
});

describe("a send with a subject line test", () => {
	let app;
	let m;
	const subjectsTo = (user) => sent.filter(({ to }) => to.endsWith(`@${user.slug}.example.org`)).map(({ subject }) => subject);

	before(async () => {
		app = await startTestApp(QSTASH_KEYS);
		m = { ...(await loadSendingModules()), pickRoute: await import("../app/api/jobs/pick-ab-winner/route.js"), emailEvents: await import("../lib/email-events.js") };
	});

	after(() => app?.stop());

	const routes = () => sendRoutes(m, { "/api/jobs/pick-ab-winner": m.pickRoute });
	const campaignOf = (user, id) => m.Campaign.findOne({ accountId: user.accountId, _id: id }).lean();

	async function setup(email, options) {
		const user = await setupSender(m, email, options);
		user.slug = email.split("@")[0];
		const campaignId = await createDraft(m, user, { subject: "Plain subject", previewText: "Plain preview", body: '<p><a href="https://example.org/">Read</a></p>' });
		const updated = await act(m, user, "update_campaign", {
			id: campaignId,
			abTest: { subjects: [{ subject: "Bold subject" }, { subject: "Curious subject", previewText: "Curious preview" }], testPercent: 30 },
		});
		assert.deepEqual(updated.abTest.variants.map(({ label, subject }) => [label, subject]), [["A", "Plain subject"], ["B", "Bold subject"], ["C", "Curious subject"]]);
		assert.equal(updated.abTest.status, "draft");
		return { user, campaignId };
	}

	async function clickAs(user, campaignId, filter, count) {
		const messages = await m.Message.find({ accountId: user.accountId, campaignId, ...filter }).limit(count).lean();
		for (const message of messages) {
			await m.Message.updateOne({ accountId: user.accountId, _id: message._id }, { $set: { sentAt: new Date(Date.now() - 600_000) } });
			const tracked = await m.emailEvents.findTrackedMessage(message._id);
			await m.emailEvents.recordEngagement({ message: tracked, type: "Click", userAgent: CHROME });
		}
	}

	async function dueNow(user, campaignId) {
		await m.Campaign.updateOne({ accountId: user.accountId, _id: campaignId }, { $set: { "abTest.pickAt": new Date(Date.now() - 1000) } });
	}

	test("the slice gets each subject in turn; after the wait the winner goes to everyone else, once", async () => {
		const { user, campaignId } = await setup("ab-test@example.com", { contacts: 40 });
		const start = Date.now();
		await act(m, user, "send_campaign", { id: campaignId });
		const testing = await campaignOf(user, campaignId);
		assert.equal(testing.abTest.status, "testing");
		assert.equal(testing.stats.recipients, 12, "30% of 40");
		const pick = published.findLast(({ url }) => url.endsWith("/api/jobs/pick-ab-winner"));
		assert.ok(Math.abs(pick.notBefore * 1000 - (start + 240 * 60_000)) < 60_000, "4 hours later by default");
		await assert.rejects(act(m, user, "send_campaign_to_more", { id: campaignId }), { code: "conflict" });

		await runJobs(routes(), { only: ({ url }) => url.endsWith("send-batch") });
		const subjects = subjectsTo(user);
		assert.deepEqual(["Plain subject", "Bold subject", "Curious subject"].map((subject) => subjects.filter((one) => one === subject).length), [4, 4, 4]);
		assert.equal(sent.findLast(({ subject }) => subject === "Curious subject").html.includes("Curious preview"), true);
		assert.equal((await campaignOf(user, campaignId)).status, "sent");

		await clickAs(user, campaignId, { variant: 2 }, 2);
		await clickAs(user, campaignId, { variant: 1 }, 1);
		const [early] = await runJobs(routes(), { only: ({ url }) => url.endsWith("pick-ab-winner") });
		assert.deepEqual(early.result, { waiting: true }, "too early, it waits for its time");

		await dueNow(user, campaignId);
		const [picked] = await runJobs(routes(), { only: ({ url }) => url.endsWith("pick-ab-winner") });
		assert.deepEqual(picked.result, { winner: 2, added: 28 });
		await runJobs(routes(), { only: ({ url }) => url.endsWith("send-batch") });
		const rest = subjectsTo(user).slice(12);
		assert.equal(rest.length, 28);
		assert.ok(rest.every((subject) => subject === "Curious subject"));

		const report = await act(m, user, "get_campaign_report", { id: campaignId });
		const { abTest } = report.campaign;
		assert.equal(abTest.status, "picked");
		assert.equal(abTest.winner, "C");
		assert.deepEqual(abTest.variants.map(({ sent, clicked }) => [sent, clicked]), [[4, 0], [4, 1], [4, 2]], "the slice's results only");
		assert.equal(abTest.variants[2].clickRate, 0.5);
		assert.equal(report.campaign.stats.sent, 40);

		const { POST } = m.pickRoute;
		const again = await (await POST(new Request("http://localhost:3000/api/jobs/pick-ab-winner", { method: "POST", body: JSON.stringify({ accountId: String(user.accountId), campaignId }) }))).json();
		assert.deepEqual(again, { skipped: "no test waiting" }, "a retried pick sends nothing twice");
	});

	test("the winner stays within the send's own limit, and a paused slice leaves the pick to its resume", async () => {
		const { user, campaignId } = await setup("ab-limit@example.com", { contacts: 40 });
		await act(m, user, "send_campaign", { id: campaignId, audienceLimit: 20 });
		assert.equal((await campaignOf(user, campaignId)).stats.recipients, 6, "30% of the 20");
		await act(m, user, "pause_campaign", { id: campaignId });
		await dueNow(user, campaignId);
		const [paused] = await runJobs(routes(), { only: ({ url }) => url.endsWith("pick-ab-winner") });
		assert.deepEqual(paused.result, { skipped: "campaign is paused" });

		await act(m, user, "resume_campaign", { id: campaignId });
		await runJobs(routes(), { only: ({ url }) => url.endsWith("send-batch") });
		const [picked] = await runJobs(routes(), { only: ({ url }) => url.endsWith("pick-ab-winner") });
		assert.deepEqual(picked.result, { winner: 0, added: 14 });
		await runJobs(routes(), { only: ({ url }) => url.endsWith("send-batch") });
		assert.equal(subjectsTo(user).length, 20);
	});

	test("a test is set on drafts only, removed with null, and copied with the campaign", async () => {
		const { user, campaignId } = await setup("ab-draft@example.com", { contacts: 2 });
		await assert.rejects(act(m, user, "update_campaign", { id: campaignId, abTest: { subjects: [] } }), { code: "validation_failed" });
		await assert.rejects(
			act(m, user, "update_campaign", { id: campaignId, abTest: { subjects: [{ subject: "B" }, { subject: "C" }, { subject: "D" }, { subject: "E" }] } }),
			{ code: "validation_failed" }
		);
		const copy = await act(m, user, "duplicate_campaign", { id: campaignId });
		assert.deepEqual(copy.abTest.variants.map(({ subject }) => subject), ["Plain subject (copy)", "Bold subject", "Curious subject"]);
		const removed = await act(m, user, "update_campaign", { id: campaignId, abTest: null });
		assert.equal(removed.abTest, null);
	});
});
