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
