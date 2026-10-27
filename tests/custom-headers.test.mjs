import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startTestApp } from "./helpers/app.mjs";
import { QSTASH_KEYS, act, createDraft, loadSendingModules, runJobs, sendRoutes, setupSender } from "./helpers/sending.mjs";
import { CUSTOM_HEADER_LIMITS, checkCustomHeaders, formatHeaderLines, getCustomHeaders } from "../lib/custom-headers.js";
import { sent } from "./stubs/ses.mjs";

// Custom email headers (parity item S10): an allowlist, no header injection, and the unsubscribe, signing and sender headers
// out of reach.
let app;
let m;

before(async () => {
	app = await startTestApp(QSTASH_KEYS);
	m = await loadSendingModules();
});

after(() => app?.stop());

describe("the rules", () => {
	test("accept X- headers and a short list of named ones, trimmed", () => {
		const result = checkCustomHeaders([
			{ name: " X-Newsletter-Group ", value: " weekly " },
			{ name: "list-id", value: "<news.example.com>" },
			{ name: "Organization", value: "Example Ltd" },
		]);
		assert.deepEqual(result.headers, [
			{ name: "X-Newsletter-Group", value: "weekly" },
			{ name: "list-id", value: "<news.example.com>" },
			{ name: "Organization", value: "Example Ltd" },
		]);
		assert.deepEqual(checkCustomHeaders([]).headers, []);
		assert.deepEqual(checkCustomHeaders(undefined).headers, []);
	});

	test("refuse the headers that decide who the email is from, how it is signed and how a reader unsubscribes", () => {
		for (const name of ["From", "To", "Reply-To", "Subject", "Date", "Message-ID", "Sender", "Return-Path", "List-Unsubscribe", "List-Unsubscribe-Post", "Feedback-ID", "DKIM-Signature", "ARC-Seal", "Authentication-Results", "Received", "MIME-Version", "Content-Type", "Content-Transfer-Encoding", "Precedence", "Bcc", "Cc"]) {
			assert.match(checkCustomHeaders([{ name, value: "x" }]).problem, /can't be changed here/, name);
		}
		for (const name of ["X-SES-CONFIGURATION-SET", "x-amz-anything", "X-PostShiba-Tenant", "X-Feedback-Id", "x-flockstack-id"]) {
			assert.match(checkCustomHeaders([{ name, value: "x" }]).problem, /set by FlockStack or the email provider/, name);
		}
	});

	test("refuse line breaks, control characters and anything that would start another header", () => {
		for (const value of ["one\r\nBcc: someone@example.com", "one\nX-Other: 1", "one\rtwo", "tab\there", "nul\u0000byte", "café", "emoji \u{1F600}", "line separator"]) {
			assert.match(checkCustomHeaders([{ name: "X-Test", value }]).problem, /plain letters/, JSON.stringify(value));
		}
		for (const name of ["X-Test\r\nBcc", "X Test", "X-Test:", "X-Tést", "X-", "1-Test", "X_Test"]) {
			const { problem } = checkCustomHeaders([{ name, value: "x" }]);
			assert.ok(problem && !problem.includes("\n"), JSON.stringify(name));
		}
	});

	test("need a value, keep within the sizes, and take a name once", () => {
		assert.match(checkCustomHeaders([{ name: "X-Empty", value: "  " }]).problem, /needs a value/);
		assert.match(checkCustomHeaders([{ name: "", value: "x" }]).problem, /needs a name/);
		assert.match(checkCustomHeaders([{ name: "X-Long", value: "a".repeat(CUSTOM_HEADER_LIMITS.value + 1) }]).problem, /under 200/);
		assert.ok(checkCustomHeaders([{ name: "X-Long", value: "a".repeat(CUSTOM_HEADER_LIMITS.value) }]).headers);
		assert.match(checkCustomHeaders([{ name: "X-A", value: "1" }, { name: "x-a", value: "2" }]).problem, /there twice/);
		const many = Array.from({ length: CUSTOM_HEADER_LIMITS.count + 1 }, (_, index) => ({ name: `X-H${index}`, value: "1" }));
		assert.match(checkCustomHeaders(many).problem, /up to 10/);
		assert.equal(checkCustomHeaders(many.slice(0, CUSTOM_HEADER_LIMITS.count)).headers.length, 10);
	});

	test("what a send reads passes the rules again, so a stored value that no longer passes is dropped", () => {
		const newsletter = { customHeaders: [{ name: "X-Ok", value: "yes" }, { name: "List-Unsubscribe", value: "<mailto:a@example.com>" }, { name: "X-Bad", value: "a\r\nBcc: b@example.com" }, { name: "From", value: "a@example.com" }] };
		assert.deepEqual(getCustomHeaders(newsletter), { "X-Ok": "yes" });
		assert.deepEqual(getCustomHeaders({}), {});
		assert.deepEqual(getCustomHeaders(null), {});
	});

	test("print as the form's lines", () => {
		assert.equal(formatHeaderLines([{ name: "X-A", value: "one" }, { name: "X-B", value: "two: three" }]), "X-A: one\nX-B: two: three");
		assert.equal(formatHeaderLines(undefined), "");
	});
});

describe("a newsletter's settings", () => {
	test("save the list through update_newsletter, show it back, and refuse a bad one without saving anything", async () => {
		const user = await setupSender(m, "headers-settings@example.com", { contacts: 1 });
		const ok = await act(m, user, "update_newsletter", { id: user.newsletterId, customHeaders: [{ name: "X-Group", value: "weekly" }] });
		assert.deepEqual(ok.customHeaders, [{ name: "X-Group", value: "weekly" }]);
		assert.deepEqual((await act(m, user, "get_newsletter", { id: user.newsletterId })).customHeaders, [{ name: "X-Group", value: "weekly" }]);
		assert.deepEqual((await act(m, user, "update_newsletter", { id: user.newsletterId, replyTo: "hi@example.com" })).customHeaders, [{ name: "X-Group", value: "weekly" }], "other changes keep them");

		await assert.rejects(act(m, user, "update_newsletter", { id: user.newsletterId, customHeaders: [{ name: "List-Unsubscribe", value: "<mailto:x@example.com>" }] }), { code: "validation_failed" });
		await assert.rejects(act(m, user, "update_newsletter", { id: user.newsletterId, customHeaders: [{ name: "X-Test", value: "a\r\nBcc: x@example.com" }] }), { code: "validation_failed" });
		assert.deepEqual((await act(m, user, "get_newsletter", { id: user.newsletterId })).customHeaders, [{ name: "X-Group", value: "weekly" }], "a refused save changes nothing");

		assert.deepEqual((await act(m, user, "update_newsletter", { id: user.newsletterId, customHeaders: [] })).customHeaders, [], "an empty list clears them");
	});

	test("the dashboard's form sends Name: value lines through the same checks", async () => {
		const user = await setupSender(m, "headers-form@example.com", { contacts: 1 });
		const { as, form } = await import("./helpers/app.mjs");
		const newsletter = await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
		const save = (customHeaders) => as(user, () => m.newsletters.saveNewsletter(null, form({ id: user.newsletterId, name: newsletter.name, slug: newsletter.slug, fromEmail: newsletter.fromEmail, postalAddress: "1 Main St", customHeaders })));
		assert.equal((await save("X-Group: weekly\nList-Id: <weekly.example.com>")).ok, true);
		const stored = await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
		assert.deepEqual(stored.customHeaders.map(({ name, value }) => [name, value]), [["X-Group", "weekly"], ["List-Id", "<weekly.example.com>"]]);
		const refused = await save("From: someone@example.com");
		assert.match(refused.error, /can't be changed here/);
	});
});

describe("a send", () => {
	test("adds the newsletter's headers, and the unsubscribe headers stay the app's", async () => {
		const user = await setupSender(m, "headers-send@example.com", { contacts: 2 });
		await act(m, user, "update_newsletter", { id: user.newsletterId, customHeaders: [{ name: "X-Group", value: "weekly" }, { name: "List-Id", value: "<weekly.example.com>" }] });
		// A value stored before the rules existed, or by a direct write: the send still refuses it.
		await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $push: { customHeaders: { $each: [{ name: "List-Unsubscribe", value: "<mailto:attacker@example.com>" }, { name: "X-Injected", value: "a\r\nBcc: attacker@example.com" }] } } });
		const campaignId = await createDraft(m, user, { subject: "With headers" });
		await act(m, user, "send_campaign", { id: campaignId });
		await runJobs(sendRoutes(m));

		const emails = sent.filter(({ to }) => to.endsWith("@headers-send.example.org"));
		assert.equal(emails.length, 2);
		for (const email of emails) {
			assert.equal(email.headers["X-Group"], "weekly");
			assert.equal(email.headers["List-Id"], "<weekly.example.com>");
			assert.match(email.headers["List-Unsubscribe"], /^<https?:\/\/[^>]+\/api\/unsubscribe\?token=/, "the reader's own one-click link");
			assert.equal(email.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
			assert.ok(email.headers["Feedback-ID"]);
			assert.equal(email.headers["X-Injected"], undefined);
			assert.ok(!JSON.stringify(email.headers).includes("attacker"));
		}
	});

	test("a test email carries them too, so a writer can see them", async () => {
		const user = await setupSender(m, "headers-test@example.com", { contacts: 1 });
		await act(m, user, "update_newsletter", { id: user.newsletterId, customHeaders: [{ name: "X-Group", value: "weekly" }] });
		const campaignId = await createDraft(m, user, { subject: "Proof" });
		await act(m, user, "send_test_email", { id: campaignId });
		const email = sent.findLast(({ to }) => to === "headers-test@example.com");
		assert.equal(email.headers["X-Group"], "weekly");
	});
});
