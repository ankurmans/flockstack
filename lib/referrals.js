import "server-only";
import { scoped } from "@/lib/account-scope";
import { isSendingEnabled } from "@/lib/config";
import { getCanonicalEmail } from "@/lib/email-aliases";
import { findGloballySuppressed } from "@/lib/global-suppressions";
import { isRateLimited } from "@/lib/rate-limit";
import { getReferralLink, getReferralPageUrl, hashIp, readReferralCode } from "@/lib/referral-links";
import { getNextReward, getUnlockedRewards, isReferralActive, sortRewards } from "@/lib/referral-rules";
import { queueReferralRewardEmail } from "@/lib/sending";
import Contact from "@/models/Contact";
import Referral from "@/models/Referral";
import ReferralReward from "@/models/ReferralReward";
import Suppression from "@/models/Suppression";

// Why a referral never counted. Shown to the newsletter's owner on the dashboard; the person who signed up is never told.
export const REJECTION_REASONS = {
	self: "Signed up with the referrer's own address or one that reaches the same inbox",
	alias: "Reaches the same inbox as an earlier referral from the same subscriber",
	same_ip: "Too many referrals from one network",
	rate_limited: "Too many referrals too fast",
	referrer_unavailable: "The referrer isn't an active subscriber",
	suppressed: "The address can't be emailed",
};

// The same network can be a household, so two referrals per referrer come from it (the referrer's own signup counts as one).
const MAX_PER_NETWORK = 2;
// A farm, or one flood of friends, past these stops counting; real referrals stay far below them.
const PER_REFERRER = { name: "referral-referrer", limit: 30, window: "1 d" };
const PER_NETWORK = { name: "referral-network", limit: 3, window: "1 d" };
const COMPARED_REFERRALS = 200;

// A signup through a referral link: remembered as pending until the new subscriber confirms (creditReferral). Only a
// contact created now counts, so nobody already on the list can be "referred", and one that came through an address
// FlockStack won't email (a suppressed one) isn't pending at all. Never throws into the signup that called it.
export async function recordReferral({ newsletter, contact, created, code, ip }) {
	if (!created || contact.status !== "pending" || !isReferralActive(newsletter)) return null;
	const referrerId = readReferralCode(code);
	if (!referrerId || referrerId === String(contact._id)) return null;
	const { accountId } = newsletter;
	const referrer = await Contact.findOne(scoped(accountId, { _id: referrerId, newsletterId: newsletter._id })).lean();
	if (!referrer) return null;

	const ipHash = hashIp(ip);
	if (ipHash) await Contact.updateOne(scoped(accountId, { _id: contact._id }), { $set: { signupIpHash: ipHash } });
	const record = (status, reason) =>
		Referral.create({ accountId, newsletterId: newsletter._id, referrerId: referrer._id, referredId: contact._id, status, ...(reason && { reason }), ...(ipHash && { ipHash }) }).then(
			() => ({ status, reason }),
			(error) => (error?.code === 11000 ? null : Promise.reject(error))
		);

	if (referrer.status !== "active") return record("rejected", "referrer_unavailable");
	const canonical = getCanonicalEmail(contact.email);
	if (getCanonicalEmail(referrer.email) === canonical) return record("rejected", "self");
	const earlier = await Referral.find(scoped(accountId, { referrerId: referrer._id, status: { $in: ["pending", "credited"] } }))
		.sort({ createdAt: -1 })
		.limit(COMPARED_REFERRALS)
		.select({ referredId: 1, ipHash: 1 })
		.lean();
	const earlierContacts = earlier.length === 0 ? [] : await Contact.find(scoped(accountId, { _id: { $in: earlier.map(({ referredId }) => referredId) } })).select({ email: 1 }).lean();
	if (earlierContacts.some(({ email }) => getCanonicalEmail(email) === canonical)) return record("rejected", "alias");
	const fromNetwork = earlier.filter((item) => item.ipHash === ipHash).length + (referrer.signupIpHash === ipHash ? 1 : 0);
	if (ipHash && fromNetwork >= MAX_PER_NETWORK) return record("rejected", "same_ip");
	if ((await isRateLimited({ ...PER_REFERRER, key: String(referrer._id) })) || (ipHash && (await isRateLimited({ ...PER_NETWORK, key: ipHash })))) {
		return record("rejected", "rate_limited");
	}

	const recorded = await record("pending");
	if (recorded) await Contact.updateOne(scoped(accountId, { _id: contact._id }), { $set: { "referral.referredBy": referrer._id, "referral.referredAt": new Date() } });
	return recorded;
}

// The new subscriber confirmed: the referral counts for the referrer, once, and the rewards that count unlocks go out.
// Claims the referral first, so two confirmations at once can't count it twice.
export async function creditReferral({ newsletter, contact }) {
	if (!isReferralActive(newsletter) || contact?.status !== "active") return null;
	const { accountId } = newsletter;
	const claimed = await Referral.findOneAndUpdate(
		scoped(accountId, { referredId: contact._id, status: "pending" }),
		{ $set: { status: "credited", creditedAt: new Date() } },
		{ returnDocument: "after" }
	).lean();
	if (!claimed) return null;
	async function reject(reason) {
		await Referral.updateOne(scoped(accountId, { _id: claimed._id }), { $set: { status: "rejected", reason }, $unset: { creditedAt: 1 } });
		return null;
	}

	const isSuppressed = (await Suppression.exists(scoped(accountId, { email: contact.email }))) || (await findGloballySuppressed([contact.email])).size > 0;
	if (isSuppressed) return reject("suppressed");
	const referrer = await Contact.findOne(scoped(accountId, { _id: claimed.referrerId, newsletterId: newsletter._id })).lean();
	if (referrer?.status !== "active") return reject("referrer_unavailable");

	const updated = await Contact.findOneAndUpdate(scoped(accountId, { _id: referrer._id }), { $inc: { "referral.count": 1 } }, { returnDocument: "after" }).lean();
	const count = updated.referral.count;
	await unlockRewards({ newsletter, referrer: updated, count });
	return { referrerId: String(referrer._id), count };
}

// The record is made first and is unique per subscriber and reward, so a reward is announced once, however many referrals
// are credited at the same time. A reward added after someone passed its number unlocks at their next referral.
async function unlockRewards({ newsletter, referrer, count }) {
	for (const reward of getUnlockedRewards(newsletter.referral?.rewards ?? [], count)) {
		try {
			await ReferralReward.create({ accountId: newsletter.accountId, newsletterId: newsletter._id, contactId: referrer._id, rewardId: reward.id, referrals: reward.referrals });
		} catch (error) {
			if (error?.code === 11000) continue;
			throw error;
		}
		if (!isSendingEnabled()) continue;
		await queueReferralRewardEmail({ newsletter, contact: referrer, reward, count }).catch((error) =>
			console.error(`[referrals] Reward email for ${referrer._id} failed:`, error.message)
		);
	}
}

// What a subscriber's referral page shows. Rewards they haven't reached keep their message and link back.
export function getReferralStatus({ newsletter, contact }) {
	const count = contact.referral?.count ?? 0;
	const rewards = sortRewards(newsletter.referral?.rewards ?? []);
	const next = getNextReward(rewards, count);
	return {
		isActive: isReferralActive(newsletter),
		count,
		link: getReferralLink(newsletter, contact._id),
		pageUrl: getReferralPageUrl({ contactId: contact._id, newsletterId: newsletter._id }, newsletter),
		next: next && { title: next.title, referrals: next.referrals, remaining: next.referrals - count },
		rewards: rewards.map((reward) => {
			const isUnlocked = reward.referrals <= count;
			return { id: reward.id, title: reward.title, referrals: reward.referrals, isUnlocked, ...(isUnlocked && { url: reward.url || null, text: reward.text || null }) };
		}),
	};
}

export function getReferralTotals(account, newsletterId) {
	const filter = (extra) => scoped(account, { newsletterId, ...extra });
	return Promise.all([
		Referral.countDocuments(filter({ status: "credited" })),
		Referral.countDocuments(filter({ status: "pending" })),
		Referral.countDocuments(filter({ status: "rejected" })),
		Contact.countDocuments(filter({ "referral.count": { $gt: 0 } })),
	]).then(([credited, pending, rejected, referrers]) => ({ credited, pending, rejected, referrers }));
}

// The subscribers with the most referrals, most first.
export function getLeaderboard(account, newsletterId, limit = 25) {
	return Contact.find(scoped(account, { newsletterId, "referral.count": { $gt: 0 } }))
		.sort({ "referral.count": -1, _id: 1 })
		.limit(limit)
		.select({ email: 1, status: 1, referral: 1 })
		.lean();
}
