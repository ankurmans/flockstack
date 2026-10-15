import assert from "node:assert/strict";
import { test } from "node:test";
import { CAMPAIGN_STEPS, getCheckFix, getSendProblem } from "../lib/campaign-steps.js";
import { getPresendChecks } from "../lib/presend-checks.js";

const READY = {
	hasPlan: true,
	choice: "now",
	blockingMessage: null,
	scheduledAt: null,
	scheduleProblem: null,
	sendEmails: 240,
	scheduleRecipients: 240,
	emailsLeft: null,
};

test("the editor goes write, review, send", () => {
	assert.deepEqual(
		CAMPAIGN_STEPS.map(({ label }) => label),
		["Write", "Review", "Send"]
	);
});

test("every check that can fail says how to fix it, except the server's own sending switch", () => {
	const { checks } = getPresendChecks({
		campaign: { subject: "", previewText: "", body: "" },
		newsletter: {},
		rendered: { html: "", bytes: 200_000 },
		senderProblem: "Add a from email to the newsletter",
		isSendingEnabled: false,
		planProblem: "This month's emails are used up",
	});
	const fixes = Object.fromEntries(checks.map((check) => [check.id, getCheckFix(check, { newsletterId: "n1" })]));

	assert.deepEqual(fixes.subject, { label: "Edit subject", field: "subject" });
	assert.equal(fixes.preview.field, "previewText");
	assert.equal(fixes.content.field, "body");
	assert.equal(fixes.unsubscribe.field, "body");
	assert.equal(fixes.size.field, "body");
	assert.deepEqual(fixes.address, { label: "Add a postal address", href: "/newsletters#postal-address" });
	assert.equal(fixes.domain.href, "/newsletters/n1");
	assert.equal(fixes.test.action, "test");
	assert.equal(fixes.plan.href, "/billing");
	assert.equal(fixes.sending, null);
	// Warnings have no message, so each one comes with a hint instead.
	for (const check of checks.filter(({ isWarning }) => isWarning)) assert.ok(fixes[check.id].hint, check.id);
});

test("sending now stops on what blocked the send dialog: a failing check, nobody to send to, the plan's emails", () => {
	assert.equal(getSendProblem(READY), null);
	assert.equal(getSendProblem({ ...READY, blockingMessage: "Add a subject" }), "Add a subject");
	assert.equal(getSendProblem({ ...READY, sendEmails: 0 }), "No contacts to send to");
	assert.equal(getSendProblem({ ...READY, emailsLeft: 100 }), "Your plan has 100 emails left this month");
	assert.equal(getSendProblem({ ...READY, emailsLeft: 240 }), null);
});

test("scheduling stops on what blocked the schedule dialog, and a scheduled campaign can still change its time", () => {
	const later = { ...READY, choice: "later" };
	assert.equal(getSendProblem(later), null);
	assert.equal(getSendProblem({ ...later, scheduleProblem: "Pick a time in the future" }), "Pick a time in the future");
	assert.equal(getSendProblem({ ...later, scheduleRecipients: 0 }), "No contacts to send to");
	assert.equal(getSendProblem({ ...later, blockingMessage: "Add content" }), "Add content");
	// Scheduled already: the dialog opened and showed the problem it had for the time picked.
	assert.equal(
		getSendProblem({ ...later, blockingMessage: "Add content", scheduledAt: "2026-11-02T09:00:00.000Z", scheduleProblem: "Add content" }),
		"Add content"
	);
	assert.equal(getSendProblem({ ...later, emailsLeft: 10 }), null, "the plan's emails are checked when it goes out");
});

test("without a plan, Send now and Schedule open the paywall instead of waiting on the checks", () => {
	for (const choice of ["now", "later"]) {
		assert.equal(getSendProblem({ ...READY, hasPlan: false, choice, blockingMessage: null, sendEmails: 0, scheduleRecipients: 0 }), null);
	}
});
