import "server-only";
import { areWelcomeEmailsPaused } from "@/lib/account-state";
import { getAccountLimits, getExtraEmailsLimit, isOnFreeTier } from "@/lib/plans";
import { countExtraEmails } from "@/lib/extra-emails";
import { CAMPAIGN_MESSAGE_KINDS } from "@/lib/sending-rules";
import { getNextUsagePeriod, startFreePlanUsage } from "@/lib/usage-period";
import Account from "@/models/Account";
import Campaign from "@/models/Campaign";
import Contact from "@/models/Contact";
import Message from "@/models/Message";
import Newsletter from "@/models/Newsletter";

// An account on Free counts its emails in months of its own that run on without payments, from the day it started, or from
// the end of the paid period a lapsed plan left. Starts them for an account that has none yet, once: the filter says so.
async function startFreeMonths(account, now) {
	const usage = account.usage;
	const anchor = usage?.paidThrough ?? account.createdAt ?? now;
	await Account.updateOne(
		{ _id: account._id, $or: [{ "usage.anchor": null }, { "usage.paidThrough": { $ne: null } }] },
		{ $set: { usage: startFreePlanUsage(anchor, now) } }
	);
	return Account.findById(account._id).lean();
}

// Moves a yearly or free plan into the month that now falls in. The filter on the old end makes it happen once.
export async function rollUsagePeriod(account, now = new Date()) {
	if (isOnFreeTier(account) && (!account.usage?.anchor || account.usage.paidThrough)) return startFreeMonths(account, now);
	const next = getNextUsagePeriod(account?.usage, now);
	if (!next) return account;
	await Account.updateOne(
		{ _id: account._id, "usage.periodEnd": account.usage.periodEnd },
		{
			$set: { "usage.periodStart": next.periodStart, "usage.periodEnd": next.periodEnd, "usage.emailsSent": 0 },
			$unset: { "usage.welcomePausedAt": 1 },
		}
	);
	return Account.findById(account._id).lean();
}

// A batch of campaign and welcome emails takes what's left of the month and no more, in one atomic update: the plan's
// emails, then the extra emails the account may send past them. extra: how many of the granted ones are past the plan's.
// Confirmation emails never wait on it (addEmailsSent): a signup that has to be confirmed always gets its email.
export async function claimPlanEmails(account, wanted) {
	if (wanted <= 0) return { granted: 0, extra: 0 };
	const limits = getAccountLimits(account);
	if (!limits) {
		await addEmailsSent(account._id, wanted);
		return { granted: wanted, extra: 0 };
	}
	const limit = limits.emails + getExtraEmailsLimit(account);
	const sent = { $ifNull: ["$usage.emailsSent", 0] };
	const granted = { $max: [0, { $min: [wanted, { $subtract: [limit, sent] }] }] };
	const before = await Account.findOneAndUpdate(
		{ _id: account._id },
		[{ $set: { "usage.emailsSent": { $add: [sent, granted] } } }],
		{ updatePipeline: true, returnDocument: "before", projection: { "usage.emailsSent": 1 } }
	).lean();
	if (!before) return { granted: 0, extra: 0 };
	const sentBefore = before.usage?.emailsSent ?? 0;
	const count = Math.max(0, Math.min(wanted, limit - sentBefore));
	return { granted: count, extra: Math.max(0, sentBefore + count - Math.max(sentBefore, limits.emails)) };
}

// The extra emails a batch really sent: the emails it claimed but didn't send go back from the top, extra ones first.
export function countExtraSent(claim, sent) {
	return Math.max(0, claim.extra - Math.max(0, claim.granted - sent));
}

export async function addEmailsSent(accountId, count) {
	if (count) await Account.updateOne({ _id: accountId }, { $inc: { "usage.emailsSent": count } });
}

// True for the month's first welcome email skipped for want of room, whose owner is told; false for the rest.
export async function claimWelcomePausedNotice(accountId) {
	const { modifiedCount } = await Account.updateOne(
		{ _id: accountId, "usage.welcomePausedAt": null },
		{ $set: { "usage.welcomePausedAt": new Date() } }
	);
	return modifiedCount > 0;
}

// A newsletter whose new subscribers get the welcome email (lib/sending-rules.js getWelcomeContent).
export async function hasWelcomeEmailsOn(accountId) {
	return Boolean(await Newsletter.exists({ accountId, "welcome.enabled": true, requireConfirmation: { $ne: true } }));
}

export function countActiveContacts(accountId) {
	return Contact.countDocuments({ accountId, status: "active" });
}

// Emails that sends already going out still have to send. Paused sends are checked again when they resume.
export async function countEmailsInFlight(accountId, newsletterId = null) {
	const sending = await Campaign.find({ accountId, ...(newsletterId && { newsletterId }), status: "sending" }).select({ _id: 1 }).lean();
	if (sending.length === 0) return 0;
	return Message.countDocuments({
		accountId,
		status: { $in: ["queued", "held"] },
		campaignId: { $in: sending.map(({ _id }) => _id) },
		kind: { $in: CAMPAIGN_MESSAGE_KINDS },
	});
}

export async function getUsage(account, now = new Date()) {
	const current = await rollUsagePeriod(account, now);
	const limits = getAccountLimits(current);
	const [subscribers, extraEmailsSent] = await Promise.all([countActiveContacts(current._id), limits ? countExtraEmails(current) : 0]);
	return {
		emailsSent: current.usage?.emailsSent ?? 0,
		emailsLimit: limits?.emails ?? null,
		extraEmailsSent,
		extraEmailsLimit: limits ? getExtraEmailsLimit(current) : null,
		subscribers,
		subscribersLimit: limits?.subscribers ?? null,
		periodStart: current.usage?.periodStart ?? null,
		periodEnd: current.usage?.periodEnd ?? null,
		welcomeEmailsPaused: areWelcomeEmailsPaused(current, now),
	};
}
