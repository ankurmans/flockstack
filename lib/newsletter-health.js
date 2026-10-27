import "server-only";
import { randomUUID } from "node:crypto";
import { scoped } from "@/lib/account-scope";
import { actionError } from "@/lib/actions/errors";
import { sendAlert } from "@/lib/alerts";
import { Types } from "@/lib/docdb";
import { connectDb } from "@/lib/db";
import { describeRate, getRateLimits, judgeRates } from "@/lib/rate-levels";
import { ACCOUNT_CHECK_DAYS } from "@/lib/sending-rules";
import Account from "@/models/Account";
import Campaign from "@/models/Campaign";
import Message from "@/models/Message";
import Newsletter from "@/models/Newsletter";

export const HEALTH_KINDS = ["campaign", "last-chance", "welcome", "confirmation", "referral", "automation"];
export const BRAKE_CODE = "newsletter_paused";

// Sent messages are the denominator, including ones that later bounced or drew a complaint.
export function newsletterHealthPipeline(account, { newsletterId, now = new Date() } = {}) {
	return [
		{ $match: scoped(account, { ...(newsletterId && { newsletterId: new Types.ObjectId(String(newsletterId)) }), sentAt: { $gte: new Date(now.getTime() - ACCOUNT_CHECK_DAYS * 86_400_000), $lte: now }, kind: { $in: HEALTH_KINDS } }) },
		{ $project: { newsletterId: 1, bouncedAt: 1, complainedAt: 1 } },
		{ $group: {
			_id: "$newsletterId", sent: { $sum: 1 },
			bounced: { $sum: { $cond: [{ $ifNull: ["$bouncedAt", false] }, 1, 0] } },
			complained: { $sum: { $cond: [{ $ifNull: ["$complainedAt", false] }, 1, 0] } },
		} },
	];
}

export function getNewsletterSendProblem(newsletter) {
	if (!newsletter?.sendingBrake?.at) return null;
	return `Sending from this newsletter is paused: ${newsletter.sendingBrake.reason}. Check its list and resume from the fleet page once its 7-day rates are under the pause levels.`;
}

export function assertNewsletterSending(newsletter) {
	const problem = getNewsletterSendProblem(newsletter);
	if (problem) throw actionError(BRAKE_CODE, problem);
}

// The brake latches at the pause level, before the account-wide block. Account and provider safeguards still apply.
export async function checkNewsletterHealth(accountId, newsletterId, { now = new Date() } = {}) {
	await connectDb();
	const [account, newsletter, rows] = await Promise.all([
		Account.findById(accountId).select({ subscriptionStatus: 1, plan: 1, comp: 1 }).lean(),
		Newsletter.findOne({ accountId, _id: newsletterId }).select({ name: 1, sendingBrake: 1 }).lean(),
		Message.aggregate(newsletterHealthPipeline(accountId, { newsletterId, now })),
	]);
	const counts = rows[0] ?? { sent: 0, bounced: 0, complained: 0 };
	const judged = judgeRates(counts, getRateLimits(account));
	if (!newsletter || !judged) return { counts, problem: null };
	const reason = describeRate(judged, `over the last ${ACCOUNT_CHECK_DAYS} days`);
	const brake = { at: newsletter.sendingBrake?.at ?? now, reason, metric: judged.metric, revision: randomUUID() };
	await Newsletter.updateOne({ accountId, _id: newsletterId }, { $set: { sendingBrake: brake } });
	await Campaign.updateMany({ accountId, newsletterId, status: "sending" }, { $set: { status: "paused", pauseReason: reason, pauseCode: BRAKE_CODE } });
	if (!newsletter.sendingBrake?.at) {
		await sendAlert({ accountId, key: `newsletter-brake:${newsletterId}`, title: "Newsletter sending paused", detail: `${newsletter.name}: ${reason}`, action: "Check this newsletter's list and its rates on the fleet page. Other newsletters keep their own sending checks.", path: "/fleet" });
	}
	return { counts, problem: reason };
}

export async function resumeNewsletterSending(account, newsletter) {
	const { problem } = await checkNewsletterHealth(account._id, newsletter._id);
	if (problem) throw actionError("conflict", `This newsletter is still over its sending limits: ${problem}`);
	// An event arriving during the check must win over an older resume.
	const filter = scoped(account, { _id: newsletter._id, "sendingBrake.at": newsletter.sendingBrake?.at ?? null, "sendingBrake.revision": newsletter.sendingBrake?.revision ?? null });
	const { matchedCount } = await Newsletter.updateOne(filter, { $unset: { sendingBrake: 1 } });
	if (!matchedCount) throw actionError("conflict", "The newsletter changed; refresh and check its rates again");
	return { resumed: true };
}
