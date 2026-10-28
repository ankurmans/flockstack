import "server-only";
import { scoped } from "@/lib/account-scope";
import { runAction } from "@/lib/actions/run-action";
import { sendAlert } from "@/lib/alerts";
import { LIMITS } from "@/lib/content-rules";
import { connectDb } from "@/lib/db";
import Account from "@/models/Account";
import Campaign from "@/models/Campaign";

// Step 8 of a briefing run (docs/BRIEFINGS-DESIGN.md, "The run"): the issue becomes a draft campaign, the content calendar gets the
// issue with its sources, and a test email goes to the briefing's test address. Everything goes through runAction, as the dashboard's
// own writes do, with via "briefing". The briefings Worker reaches this through the API Worker's BriefingsDelivery entrypoint; a
// self-hosted server's hourly cron calls it directly. Every step is safe to repeat: a run cut off mid-delivery is delivered again on
// the next tick and finds what it already made.
const VIA = "briefing";
const SUBJECT_MAX = 200;
const PREVIEW_MAX = 300;
// A note for one run is sent once, however often its delivery is retried.
const RUN_NOTE_COOLDOWN_MINUTES = 7 * 24 * 60;

const clip = (value, max) => String(value ?? "").trim().slice(0, max);

async function loadAccount(accountId) {
	await connectDb();
	const account = await Account.findById(accountId).lean();
	if (!account) throw new Error("The briefing's account is gone");
	return account;
}

// One newsletter item per issue, linked to the draft: an issue belongs to one newsletter item (the unique (accountId, campaignId)
// index), and an item per story would fill a newsletter's 5,000-item calendar within a year of daily runs. The stories' own pages
// come first in its references, then what they cite, up to the calendar's limit.
export function issueReferences(stories = []) {
	const seen = new Set();
	const references = [];
	const add = (reference) => {
		const url = clip(reference?.url, LIMITS.url);
		if (!/^https?:\/\//i.test(url) || seen.has(url) || references.length >= LIMITS.references) return;
		seen.add(url);
		references.push({ url, label: clip(reference.label, LIMITS.label), kind: reference.kind === "evidence" ? "evidence" : "reference" });
	};
	for (const story of stories) add({ url: story.url, label: story.title, kind: "reference" });
	for (const story of stories) for (const reference of story.references ?? []) add(reference);
	return references;
}

function issueBody(stories = []) {
	return stories
		.map((story) => `- ${clip(story.title, 300)}`)
		.join("\n")
		.slice(0, LIMITS.body);
}

// The owner's note on the run: the checks and the cost. It is never part of the issue.
export function describeRun({ checks = [], costUsd = 0, testEmail, testResult }) {
	const count = (status) => checks.filter((check) => check.status === status).length;
	const lines = [`Checks: ${count("pass")} passed, ${count("warning")} ${count("warning") === 1 ? "warning" : "warnings"}, ${count("blocker")} ${count("blocker") === 1 ? "blocker" : "blockers"}.`];
	for (const check of checks.filter(({ status }) => status !== "pass")) lines.push(`${check.status === "blocker" ? "Blocker" : "Warning"}: ${clip(check.message, 300)}`);
	lines.push(`Model cost of this run: $${Number(costUsd || 0).toFixed(4)}.`);
	if (testResult === "sent") lines.push(`A test email went to ${testEmail}.`);
	else if (testResult === "already") lines.push(`A test email was already sent for this draft.`);
	else if (testResult) lines.push(`The test email to ${testEmail || "the test address"} was not sent: ${testResult}`);
	return lines.join("\n");
}

async function sendTest(account, campaignId, testEmail) {
	if (!testEmail) return "the briefing has no test address.";
	const campaign = await Campaign.findOne(scoped(account, { _id: campaignId })).select({ status: 1, testSentAt: 1 }).lean();
	if (campaign?.testSentAt) return "already";
	if (campaign?.status !== "draft") return "the campaign is no longer a draft.";
	try {
		await runAction("send_test_email", { account, input: { id: campaignId, to: [testEmail] }, via: VIA });
		return "sent";
	} catch (error) {
		return `${error?.message ?? "it failed"}`.replace(/\.?$/, ".");
	}
}

export async function deliverIssue(payload) {
	const account = await loadAccount(payload.accountId);
	const campaign = await runAction("create_campaign", {
		account,
		via: VIA,
		input: {
			newsletter: String(payload.newsletterId),
			externalId: `briefing:${payload.briefingId}:${payload.slot}`,
			subject: clip(payload.subject, SUBJECT_MAX),
			previewText: clip(payload.previewText, PREVIEW_MAX),
			format: "markdown",
			content: String(payload.markdown ?? ""),
		},
	});
	const { item } = await runAction("create_content_item", {
		account,
		via: VIA,
		input: {
			newsletter: String(payload.newsletterId),
			channel: "newsletter",
			externalId: clip(`briefing:${payload.briefingId}:${payload.slot}`, LIMITS.externalId),
			title: clip(payload.subject, LIMITS.title) || "Briefing",
			body: issueBody(payload.stories),
			references: issueReferences(payload.stories),
			campaign: campaign.id,
		},
	});
	// An item made by an earlier, cut-off delivery may not have its issue yet.
	if (item.campaign?.id !== campaign.id) await runAction("link_content_campaign", { account, via: VIA, input: { id: item.id, campaign: campaign.id } });
	const testResult = await sendTest(account, campaign.id, payload.testEmail);
	await sendAlert({
		accountId: account._id,
		key: `briefing-run-${payload.runId}`,
		title: "A briefing draft is ready to review",
		detail: `"${clip(payload.subject, SUBJECT_MAX)}"\n${describeRun({ checks: payload.checks, costUsd: payload.costUsd, testEmail: payload.testEmail, testResult })}`,
		path: `/campaigns/${campaign.id}`,
		cooldownMinutes: RUN_NOTE_COOLDOWN_MINUTES,
	});
	return { campaignId: campaign.id };
}

// A one-line word to the owner about a run that made no draft (no news, the budget, a failure). It goes to the account owner's
// address, like every account alert; `to` is accepted for the engine's contract and not used.
export async function notifyOwner({ accountId, briefingId, subject, text }) {
	await sendAlert({
		accountId,
		key: `briefing-${briefingId}-${clip(subject, 60).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
		title: clip(subject, SUBJECT_MAX) || "A briefing needs a look",
		detail: clip(text, 2000),
		path: /^[a-f0-9]{24}$/i.test(String(briefingId)) ? `/briefings/${briefingId}` : "",
	});
	return { notified: true };
}
