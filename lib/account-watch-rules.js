import { isBlocked } from "./account-state.js";
import { POSTMASTER, WATCH } from "./config.js";
import { formatNumber } from "./format.js";
import { describeBlockLevel, formatRate } from "./rate-levels.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// The early warnings, in the order the dashboard shows them: the last 7 days' bounces and complaints
// (lib/account-health.js), Gmail's spam rate (lib/postmaster.js) and a finding SES reports on the account's tenant
// (lib/tenant-events.js). A spam trap has none: one hit blocks the account at once.
export const WATCH_ISSUES = ["bounces", "complaints", "gmail", "provider"];

// The 7-day counts at the watch level (WATCH in lib/config.js), each with its numbers. Like the block level, a rate needs
// its minimum count, so one complaint or a few bounces never warn.
export function judgeWatch({ sent = 0, bounced = 0, complained = 0 } = {}) {
	if (sent === 0) return [];
	const issues = [];
	if (bounced >= WATCH.minBounces && bounced / sent > WATCH.bounceRate) {
		issues.push({ issue: "bounces", rate: bounced / sent, limit: WATCH.bounceRate, count: bounced, sent });
	}
	if (complained >= WATCH.minComplaints && complained / sent > WATCH.complaintRate) {
		issues.push({ issue: "complaints", rate: complained / sent, limit: WATCH.complaintRate, count: complained, sent });
	}
	return issues;
}

export function isGmailWatch(rate) {
	return rate >= WATCH.gmailRate && rate < POSTMASTER.blockRate;
}

const LIST_ADVICE = "Turn on confirmed opt-in so new signups prove their address, and leave the import or segment these came from out of your next sends.";

// What the owner reads, by email and on the dashboard: the numbers, what blocks the account, and what to do.
export function describeWatch({ issue, rate, count, sent, detail }) {
	const counted = sent ? ` (${formatNumber(count)} of ${formatNumber(sent)})` : "";
	switch (issue) {
		case "bounces":
			return {
				title: "Bounces are getting close to a block",
				summary: `${formatRate(rate)} of your emails bounced over the last 7 days. The account is blocked at ${describeBlockLevel("bounce")}.`,
				detail: `${formatRate(rate)} of the emails you sent over the last 7 days bounced${counted}. At ${describeBlockLevel("bounce")}, FlockStack blocks the account and nothing is sent until it's unblocked.`,
				action: `What to do: remove contacts you can't vouch for, like an old list or one from somewhere else. ${LIST_ADVICE}`,
			};
		case "complaints":
			return {
				title: "Spam complaints are getting close to a block",
				summary: `${formatRate(rate)} of your emails were marked as spam over the last 7 days. The account is blocked at ${describeBlockLevel("complaint")}.`,
				detail: `${formatRate(rate)} of the emails you sent over the last 7 days were marked as spam${counted}. At ${describeBlockLevel("complaint")}, FlockStack blocks the account and nothing is sent until it's unblocked.`,
				action: `What to do: send only to people who asked for your emails, and leave out readers who haven't opened in months. ${LIST_ADVICE}`,
			};
		case "gmail":
			return {
				title: "Gmail's spam rate is getting close to a block",
				summary: `Gmail reported a spam rate of ${formatRate(rate)} for your emails. The account is blocked at ${formatRate(POSTMASTER.blockRate)}.`,
				detail: `Gmail reported a spam rate of ${formatRate(rate)} for your emails (Google Postmaster Tools). At ${formatRate(POSTMASTER.blockRate)}, FlockStack blocks the account and nothing is sent until it's unblocked.`,
				action: `What to do: send only to people who asked for your emails, and leave out readers who haven't opened in months. ${LIST_ADVICE}`,
			};
		default:
			return {
				title: "Our email provider flagged your sending",
				summary: `${detail}. A high-impact finding, or the provider pausing your sending, blocks the account.`,
				detail: `${detail}. If the provider rates a finding high impact, or pauses your sending, FlockStack blocks the account and nothing is sent until it's unblocked.`,
				action: `What to do: fix what the finding names. For a bounce or complaint finding, remove contacts you can't vouch for. ${LIST_ADVICE} For an authentication finding (SPF, DKIM, DMARC), check your domain's records on the Domains page.`,
			};
	}
}

// The warnings to show on the dashboard: seen within the period, on an account that isn't blocked (its own bar says more).
export function getActiveWatch(account, now = new Date()) {
	if (!account?.watch || isBlocked(account)) return [];
	const since = now.getTime() - WATCH.periodDays * DAY_MS;
	return WATCH_ISSUES.flatMap((issue) => {
		const seen = account.watch[issue];
		const at = seen?.seenAt ? new Date(seen.seenAt).getTime() : 0;
		return at >= since ? [{ issue, ...seen }] : [];
	});
}
