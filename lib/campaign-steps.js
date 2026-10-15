import { formatCount } from "./format.js";

// The campaign editor's steps (FormCampaign): write the issue, review it, send it.
export const CAMPAIGN_STEPS = [
	{ id: "write", label: "Write" },
	{ id: "review", label: "Review" },
	{ id: "send", label: "Send" },
];

// What the review step offers for a check that needs a look (lib/presend-checks.js): a field of the draft, a page or
// the test email. Warnings have no message of their own, so they get a hint. A settings field (FormNewsletter's id)
// opens scrolled to and focused.
const FIXES = {
	subject: { label: "Edit subject", field: "subject" },
	"subject-length": { label: "Edit subject", field: "subject", hint: "Inboxes cut longer subjects off" },
	preview: { label: "Add preview text", field: "previewText", hint: "Inboxes show it after the subject" },
	content: { label: "Edit content", field: "body" },
	unsubscribe: { label: "Edit HTML", field: "body" },
	size: { label: "Edit content", field: "body" },
	address: { label: "Add a postal address", page: "settings", field: "postal-address" },
	domain: { label: "Open settings", page: "settings" },
	test: { label: "Send a test", action: "test", hint: "See it in a real inbox before your readers do" },
	plan: { label: "See plans", href: "/billing" },
};

export function getCheckFix(check, { newsletterId }) {
	const fix = FIXES[check.id];
	if (fix?.page !== "settings") return fix ?? null;
	const { page, field, ...rest } = fix;
	// The editor opened its newsletter already, and /newsletters/<id>'s redirect would drop the #.
	return { ...rest, href: field ? `/newsletters#${field}` : `/newsletters/${newsletterId}` };
}

// Why the send step's button can't go yet, or null. Without a plan it opens the paywall instead, so nothing stops it;
// otherwise the same rules as the send and schedule dialogs had.
export function getSendProblem({
	hasPlan,
	choice,
	blockingMessage,
	scheduledAt,
	scheduleProblem,
	sendEmails,
	scheduleRecipients,
	emailsLeft,
}) {
	if (!hasPlan) return null;
	if (choice === "later") {
		if (blockingMessage && !scheduledAt) return blockingMessage;
		return scheduleProblem || (scheduleRecipients === 0 ? NO_RECIPIENTS : null);
	}
	if (blockingMessage) return blockingMessage;
	if (sendEmails === 0) return NO_RECIPIENTS;
	if (emailsLeft !== null && sendEmails > emailsLeft) return `Your plan has ${formatCount(emailsLeft, "email")} left this month`;
	return null;
}

const NO_RECIPIENTS = "No contacts to send to";
