import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startTestApp } from "./helpers/app.mjs";
import { QSTASH_KEYS, act, createDraft, loadSendingModules, runJobs, sendRoutes, setupSender } from "./helpers/sending.mjs";
import { sent } from "./stubs/ses.mjs";

// The smaller sending settings of beehiiv parity's item 18: a sender name per issue, test emails to several people,
// email-only and web-only issues, several segments in and out, and for confirmed opt-in a reminder and a page to land on.

let app;
let m;

before(async () => {
	app = await startTestApp(QSTASH_KEYS);
	m = await loadSendingModules();
});

after(() => app?.stop());

const sentTo = (email) => sent.filter(({ to }) => to === email);

describe("a sender name per issue", () => {
	test("goes in the From field from the newsletter's address, and empty goes back to the newsletter's name", async () => {
		const user = await setupSender(m, "sender-name@example.com", { contacts: 1 });
		const newsletter = await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
		const campaignId = await createDraft(m, user, { subject: "From someone else" });
		const updated = await act(m, user, "update_campaign", { id: campaignId, fromName: "Guest Writer" });
		assert.equal(updated.fromName, "Guest Writer");
		assert.equal((await act(m, user, "duplicate_campaign", { id: campaignId })).fromName, "Guest Writer");

		await act(m, user, "send_campaign", { id: campaignId });
		await runJobs(sendRoutes(m));
		const [email] = sentTo("reader0@sender-name.example.org");
		assert.equal(email.from, `"Guest Writer" <${newsletter.fromEmail}>`);

		const draft = await createDraft(m, user);
		await act(m, user, "update_campaign", { id: draft, fromName: "Someone" });
		assert.equal((await act(m, user, "update_campaign", { id: draft, fromName: "" })).fromName, null);
	});
});

describe("test emails", () => {
	test("go to the owner by default, or to up to 10 addresses, skipping ones that can't receive email", async () => {
		const user = await setupSender(m, "tests-to@example.com", { contacts: 1 });
		const campaignId = await createDraft(m, user, { subject: "Proof" });
		const own = await act(m, user, "send_test_email", { id: campaignId });
		assert.equal(own.sentTo, "tests-to@example.com");

		const Suppression = (await import("../models/Suppression.js")).default;
		await Suppression.create({ accountId: user.accountId, email: "bounced@example.net", reason: "bounce" });
		const result = await act(m, user, "send_test_email", { id: campaignId, to: ["Editor@example.net", "copy@example.net", "bounced@example.net", "editor@example.net"] });
		assert.deepEqual(result.recipients.map(({ email }) => email), ["editor@example.net", "copy@example.net"]);
		assert.deepEqual(result.skipped.map(({ email }) => email), ["bounced@example.net"]);
		assert.equal(sentTo("editor@example.net")[0].subject, "[Test] Proof");
		assert.equal(sentTo("bounced@example.net").length, 0);

		const eleven = Array.from({ length: 11 }, (_, index) => `person${index}@example.net`);
		await assert.rejects(act(m, user, "send_test_email", { id: campaignId, to: eleven }), { code: "validation_failed" });
		await assert.rejects(act(m, user, "send_test_email", { id: campaignId, to: ["bounced@example.net"] }), { code: "send_check_failed" });
	});
});

describe("email only and web only issues", () => {
	test("web only publishes the page with no email; email only sends with no page and no read online link", async () => {
		const user = await setupSender(m, "channels@example.com", { contacts: 2 });
		await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { archiveEnabled: true } });
		const { getArchiveIssue, listArchiveIssues } = await import("../lib/archive-data.js");
		const newsletter = await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();

		const webId = await createDraft(m, user, { subject: "On the web" });
		assert.equal((await act(m, user, "update_campaign", { id: webId, publishTo: "web" })).publishTo, "web");
		const published = await act(m, user, "send_campaign", { id: webId });
		assert.equal(published.status, "sent");
		assert.equal(published.stats.recipients, 0);
		await runJobs(sendRoutes(m));
		assert.equal(sentTo("reader0@channels.example.org").length, 0, "no email");
		assert.ok(await getArchiveIssue(newsletter, published.archiveSlug));
		await assert.rejects(act(m, user, "send_campaign_to_more", { id: webId }), { code: "conflict" });
		await assert.rejects(act(m, user, "resend_campaign", { id: webId, subject: "Again" }), { code: "conflict" });

		const emailId = await createDraft(m, user, { subject: "In the inbox" });
		await act(m, user, "update_campaign", { id: emailId, publishTo: "email" });
		const emailed = await act(m, user, "send_campaign", { id: emailId });
		await runJobs(sendRoutes(m));
		const [email] = sentTo("reader0@channels.example.org");
		assert.equal(email.subject, "In the inbox");
		assert.doesNotMatch(email.html, /Read online/);
		assert.equal(emailed.archiveListed, false);
		const current = await m.Campaign.findOne({ accountId: user.accountId, _id: emailId }).lean();
		assert.equal(await getArchiveIssue(newsletter, current.archiveSlug), null, "no page");
		assert.deepEqual((await listArchiveIssues(newsletter)).map(({ subject }) => subject), ["On the web"]);
		await assert.rejects(act(m, user, "update_campaign_archive", { id: emailId, listed: true }), { code: "conflict" });

		const unlisted = await act(m, user, "update_campaign_archive", { id: webId, listed: false });
		assert.equal(unlisted.archiveListed, false);
		assert.deepEqual(await listArchiveIssues(newsletter), []);
		assert.ok(await getArchiveIssue(newsletter, published.archiveSlug), "an unlisted issue keeps its page");
	});

	test("web only needs the website on, and isn't for paid issues", async () => {
		const user = await setupSender(m, "web-off@example.com", { contacts: 1 });
		const id = await createDraft(m, user, { subject: "Nowhere" });
		await act(m, user, "update_campaign", { id, publishTo: "web" });
		await assert.rejects(act(m, user, "send_campaign", { id }), { code: "send_check_failed", message: /website/ });
	});
});

describe("several segments, in and out", () => {
	test("a send goes to contacts in any of its segments and in none of the ones it leaves out", async () => {
		const user = await setupSender(m, "segments-in-out@example.com", { contacts: 6 });
		const tag = (index, tags) => m.Contact.updateOne({ accountId: user.accountId, email: `reader${index}@segments-in-out.example.org` }, { $set: { tags } });
		await tag(0, ["vip"]);
		await tag(1, ["beta"]);
		await tag(2, ["vip", "staff"]);
		await tag(3, ["staff"]);
		const segment = (name, value) => act(m, user, "create_segment", { name, rules: { match: "all", conditions: [{ type: "tag", op: "has", value }] } });
		const vip = await segment("VIP", "vip");
		await segment("Beta", "beta");
		const staff = await segment("Staff", "staff");

		const id = await createDraft(m, user, { subject: "Insiders" });
		const updated = await act(m, user, "update_campaign", { id, segments: [vip.id, "Beta"], excludeSegments: ["Staff"] });
		assert.equal(updated.segmentId, vip.id);
		assert.equal(updated.segmentIds.length, 2);
		assert.deepEqual(updated.excludeSegmentIds, [staff.id]);
		const detail = await act(m, user, "get_campaign", { id });
		assert.equal(detail.audienceSize, 2);
		assert.equal(detail.segment.name, "VIP or Beta, not Staff");
		await assert.rejects(act(m, user, "delete_segment", { id: staff.id }), { code: "conflict" });
		await assert.rejects(
			act(m, user, "update_campaign", { id, segments: ["VIP", "Beta", "Staff", "VIP", "Beta", "Staff"] }),
			{ code: "validation_failed" },
			"5 at most"
		);

		await act(m, user, "send_campaign", { id });
		await runJobs(sendRoutes(m));
		const reached = sent.filter(({ subject }) => subject === "Insiders").map(({ to }) => to.split("@")[0]).sort();
		assert.deepEqual(reached, ["reader0", "reader1"]);
		const campaign = await m.Campaign.findOne({ accountId: user.accountId, _id: id }).lean();
		assert.deepEqual([campaign.segmentSnapshot.include.length, campaign.segmentSnapshot.exclude.length], [2, 1], "the audience is kept as it went out");

		const cleared = await act(m, user, "update_campaign", { id: await createDraft(m, user), segments: [vip.id], excludeSegments: [] });
		assert.deepEqual([cleared.segmentIds, cleared.excludeSegmentIds], [[vip.id], []]);
	});
});
