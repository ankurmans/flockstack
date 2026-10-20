import { isCloud, isSendingEnabled } from "./config.js";
import { formatDate, formatNumber } from "./format.js";
import { FREE_PLAN, getAccountLimits, getExtraEmailsLimit, isOnFreePlan, isOnFreeTier, isPaidStatus } from "./plans.js";
import { getNextUsagePeriod } from "./usage-period.js";

export { isPaidStatus };

// Stable codes: the dashboard shows an upgrade link for them, the API and MCP will return them.
export const ERROR_CODES = {
	subscriptionRequired: "subscription_required",
	accountBlocked: "account_blocked",
	planLimitEmails: "plan_limit_emails",
	planLimitSubscribers: "plan_limit_subscribers",
};

// The owner deleted the account and it waits for its purge (lib/account-deletion.js).
export function isDeletionPending(account) {
	return Boolean(account?.deletion?.requestedAt);
}

// Whether the account may use the product: every account may, as every account has a plan (Free when it pays for none),
// and a self-hosted server has no plans. Only one waiting to be deleted may not, so it sends nothing, takes no signups
// and its archive is offline.
export function hasActiveSubscription(account) {
	return !isDeletionPending(account);
}

// What hasActiveSubscription and the plan (lib/plans.js getAccountPlan, lib/free-plan.js showsSentWithLink) read, for
// queries that load only that.
export const ACCESS_FIELDS = { subscriptionStatus: 1, plan: 1, comp: 1, sentWithLink: 1, deletion: 1 };

// Blocked after spam signals or by an admin (lib/account-blocks.js), stored as "paused".
export function isBlocked(account) {
	return account?.status === "paused";
}

// Who blocked it (account.pausedBy), for the admins.
export const BLOCKED_BY = {
	admin: "an admin",
	rates: "the 7-day check",
	campaign: "a campaign's rates",
	slice: "a first send's slice",
	trap: "a spam trap",
	ses: "SES",
	postshiba: "PostShiba",
	gmail: "Gmail's spam rate",
};

// On FlockStack Cloud the owner asks in the support chat, which the dashboard opens from its blocked bar; the API and
// emails give its address (supportUrl, lib/support.js).
export function getUnblockHint(supportUrl) {
	if (!isCloud()) return "An admin can unblock it on the admin page.";
	return supportUrl ? `Chat with us to unblock it: ${supportUrl}` : "Chat with us to unblock it.";
}

// What a blocked account's owner reads wherever something is refused: why, and who unblocks it.
export function getBlockedMessage(account, supportUrl) {
	const reason = account?.pauseReason?.trim().replace(/\.$/, "");
	return `This account is blocked${reason ? `: ${reason}` : ""}. ${getUnblockHint(supportUrl)}`;
}

// The account menu: whether the account sends, and what to do when it doesn't.
export function getSendingStatus(account) {
	if (isBlocked(account)) return { label: "Account blocked", hint: getBlockedMessage(account), tone: "red" };
	if (!isSendingEnabled()) return { label: "Sending off", hint: "Sending is off on this server", tone: "gray" };
	return { label: "Sending on", hint: null, tone: "green" };
}

export function isPlanLimitCode(code) {
	return code === ERROR_CODES.planLimitEmails || code === ERROR_CODES.planLimitSubscribers;
}

export function codedError({ code, message }) {
	return Object.assign(new Error(message), { code });
}

// For BadgeStatus: "blocked" when an admin or a spam signal blocked the account, "free" on the Free plan, "active" on an
// admin's free plan, else the billing provider's status (active, past_due…).
export function getAccountStatus(account) {
	if (isDeletionPending(account)) return "deleting";
	if (!isCloud()) return isBlocked(account) ? "blocked" : "active";
	if (isBlocked(account)) return "blocked";
	if (isOnFreePlan(account)) return "active";
	if (isOnFreeTier(account)) return "free";
	return account.subscriptionStatus;
}

// Every email the account sends needs it to be neither blocked nor waiting for its deletion, welcome and confirmation
// emails included.
export function getAccountSendProblem(account) {
	if (isBlocked(account)) return { code: ERROR_CODES.accountBlocked, message: getBlockedMessage(account) };
	if (!hasActiveSubscription(account)) {
		return { code: ERROR_CODES.subscriptionRequired, message: "This account is being deleted" };
	}
	return null;
}

// recipients: the emails this send adds. queued: emails other sends haven't sent yet. Over the limits nothing is cut: the
// send is refused with the numbers, and everything the account has stays. The Free plan's messages name it and say what
// to do; a paid plan's say "your plan".
export function getPlanLimitProblem({ account, emailsSent, queued = 0, recipients, activeContacts }) {
	const limits = getAccountLimits(account);
	if (!limits) return null;
	const isFree = isOnFreeTier(account);
	if (activeContacts > limits.subscribers) {
		return {
			code: ERROR_CODES.planLimitSubscribers,
			message: isFree
				? `You have ${formatNumber(activeContacts)} subscribers and the ${FREE_PLAN.name} plan allows ${formatNumber(limits.subscribers)}. Nothing is deleted, but campaigns can't go out until you upgrade or remove subscribers.`
				: `You have ${formatNumber(activeContacts)} subscribers and your plan allows ${formatNumber(limits.subscribers)}. Upgrade to send.`,
		};
	}
	const extra = getExtraEmailsLimit(account);
	const left = Math.max(0, limits.emails + extra - emailsSent - queued);
	if (recipients > left) {
		const message = extra
			? `This send needs ${formatNumber(recipients)} emails and your plan has ${formatNumber(left)} left this month, extra emails included. Raise your extra emails limit or upgrade to send.`
			: isFree
				? `This send needs ${formatNumber(recipients)} emails and the ${FREE_PLAN.name} plan has ${formatNumber(left)} left this month, of ${formatNumber(limits.emails)}. Upgrade to send, or send to fewer people.`
				: `This send needs ${formatNumber(recipients)} emails and your plan has ${formatNumber(left)} left this month. Upgrade to send.`;
		return { code: ERROR_CODES.planLimitEmails, message };
	}
	return null;
}

// Welcome emails take room in the month's emails like campaign emails, and stop once it's used up until the month
// resets or the plan grows (lib/sending.js). A stored month that's over counts as reset, before rollUsagePeriod moves it.
export function areWelcomeEmailsPaused(account, now = new Date()) {
	const limits = getAccountLimits(account);
	if (!limits || !hasActiveSubscription(account)) return false;
	const emailsSent = getNextUsagePeriod(account.usage, now) ? 0 : (account.usage?.emailsSent ?? 0);
	return emailsSent >= limits.emails + getExtraEmailsLimit(account);
}

// What the owner reads once welcome emails stop: the email that tells them, and the dashboard's notices.
export function getWelcomePauseNotice({ emailsLimit, extraEmailsLimit = 0, periodEnd }) {
	const resetsOn = formatDate(periodEnd);
	const extra = extraEmailsLimit ? ` and ${formatNumber(extraEmailsLimit)} extra emails` : "";
	return {
		title: `Welcome emails paused: you've used this month's ${formatNumber(emailsLimit)} emails${extra}`,
		detail: `They resume when your emails reset${resetsOn ? ` on ${resetsOn}` : ""}, or as soon as you upgrade. Subscribers who join before then won't get one later.`,
	};
}
