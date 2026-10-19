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
