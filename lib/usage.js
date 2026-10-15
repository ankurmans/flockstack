import "server-only";
import { areWelcomeEmailsPaused } from "@/lib/account-state";
import { getAccountLimits } from "@/lib/plans";
import { CAMPAIGN_MESSAGE_KINDS } from "@/lib/sending-rules";
import { getNextUsagePeriod } from "@/lib/usage-period";
import Account from "@/models/Account";
import Campaign from "@/models/Campaign";
import Contact from "@/models/Contact";
import Message from "@/models/Message";
import Newsletter from "@/models/Newsletter";

// Moves a yearly or free plan into the month that now falls in. The filter on the old end makes it happen once.
export async function rollUsagePeriod(account, now = new Date()) {
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

// A batch of campaign and welcome emails takes what's left of the month and no more, in one atomic update.
// Confirmation emails never wait on it (addEmailsSent): a signup that has to be confirmed always gets its email.
export async function claimPlanEmails(account, wanted) {
	if (wanted <= 0) return 0;
	const limits = getAccountLimits(account);
	if (!limits) {
		await addEmailsSent(account._id, wanted);
		return wanted;
	}
	const limit = limits.emails;
	const sent = { $ifNull: ["$usage.emailsSent", 0] };
	const granted = { $max: [0, { $min: [wanted, { $subtract: [limit, sent] }] }] };
	const before = await Account.findOneAndUpdate(
		{ _id: account._id },
		[{ $set: { "usage.emailsSent": { $add: [sent, granted] } } }],
		{ updatePipeline: true, returnDocument: "before", projection: { "usage.emailsSent": 1 } }
	).lean();
	if (!before) return 0;
	return Math.max(0, Math.min(wanted, limit - (before.usage?.emailsSent ?? 0)));
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
export async function countEmailsInFlight(accountId) {
	const sending = await Campaign.find({ accountId, status: "sending" }).select({ _id: 1 }).lean();
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
	const subscribers = await countActiveContacts(current._id);
	return {
		emailsSent: current.usage?.emailsSent ?? 0,
		emailsLimit: limits?.emails ?? null,
		subscribers,
		subscribersLimit: limits?.subscribers ?? null,
		periodStart: current.usage?.periodStart ?? null,
		periodEnd: current.usage?.periodEnd ?? null,
		welcomeEmailsPaused: areWelcomeEmailsPaused(current, now),
	};
}
