import "server-only";
import { createHash } from "node:crypto";
import { scoped } from "@/lib/account-scope";
import { getGiftExpiry } from "@/lib/gift-rules";
import { getGiftRedeemUrl } from "@/lib/gifts";
import { findTier, getNewsletterTiers } from "@/lib/tier-rules";
import { emitWebhookEvent } from "@/lib/webhooks";
import Contact from "@/models/Contact";
import Gift from "@/models/Gift";
import ReferralCode from "@/models/ReferralCode";
import ReferralReward from "@/models/ReferralReward";

export const MAX_REFERRAL_CODES = 500;
export const REFERRAL_FULFILL_BATCH = 25;

export function readRewardCodes(codes) {
	if (!Array.isArray(codes) || !codes.length || codes.length > MAX_REFERRAL_CODES) throw new Error(`Add 1 to ${MAX_REFERRAL_CODES} codes at a time.`);
	const unique = new Set();
	for (const code of codes) {
		if (typeof code !== "string" || !code.trim() || code !== code.trim() || code.length > 200 || /[\u0000-\u001f\u007f]/.test(code)) throw new Error("Use exact codes, 1 to 200 characters each, without outer spaces or control characters.");
		unique.add(code);
	}
	return [...unique];
}

export async function addRewardCodes({ newsletter, rewardId, codes }) {
	const exact = readRewardCodes(codes);
	let added = 0;
	for (const code of exact) {
		try {
			await ReferralCode.create({ accountId: newsletter.accountId, newsletterId: newsletter._id, rewardId, code, codeHash: createHash("sha256").update(code).digest("hex") });
			added++;
		} catch (error) {
			if (error?.code !== 11000) throw error;
		}
	}
	return { added, duplicates: codes.length - added };
}

export async function getRewardStock(newsletter) {
	const base = scoped(newsletter.accountId, { newsletterId: newsletter._id });
	const [stock, pending] = await Promise.all([
		ReferralCode.aggregate([{ $match: base }, { $group: { _id: "$rewardId", available: { $sum: { $cond: [{ $ifNull: ["$receiptId", false] }, 0, 1] } }, assigned: { $sum: { $cond: [{ $ifNull: ["$receiptId", false] }, 1, 0] } } } }]),
		ReferralReward.aggregate([{ $match: { ...base, state: "pending", "benefit.kind": { $in: ["code", "gift"] } } }, { $group: { _id: "$rewardId", count: { $sum: 1 } } }]),
	]);
	const byId = new Map(stock.map((row) => [row._id, row]));
	for (const row of pending) byId.set(row._id, { ...byId.get(row._id), pending: row.count });
	return [...byId].map(([rewardId, row]) => ({ rewardId, available: row.available ?? 0, assigned: row.assigned ?? 0, pending: row.pending ?? 0 }));
}

// Each resource has its own receipt uniqueness constraint. A crash between allocation and marking ready is recoverable.
export async function fulfillReward({ newsletter, receipt, contact }) {
	if (!receipt.benefit || receipt.state === "ready" || contact?.status !== "active") return receipt;
	const account = newsletter.accountId;
	const benefit = receipt.benefit;
	let set;
	if (benefit.kind === "code") {
		let code = await ReferralCode.findOne(scoped(account, { receiptId: receipt._id })).lean();
		if (!code) {
			try {
				code = await ReferralCode.findOneAndUpdate(scoped(account, { newsletterId: newsletter._id, rewardId: receipt.rewardId, receiptId: null }), { $set: { receiptId: receipt._id, assignedAt: new Date() } }, { sort: { _id: 1 }, returnDocument: "after" }).lean();
			} catch (error) {
				if (error?.code !== 11000) throw error;
				code = await ReferralCode.findOne(scoped(account, { receiptId: receipt._id })).lean();
			}
		}
		if (!code) return receipt;
		set = { codeId: code._id };
	} else if (benefit.kind === "gift") {
		let gift = await Gift.findOne(scoped(account, { referralRewardId: receipt._id })).lean();
		if (!gift) {
			const tier = findTier(getNewsletterTiers(newsletter), benefit.tierId);
			if (!tier) return receipt;
			const now = new Date();
			try {
				gift = await Gift.create({ accountId: account, newsletterId: newsletter._id, referralRewardId: receipt._id, tierId: benefit.tierId, months: benefit.months, amountCents: 0, currency: newsletter.paidTier?.currency || "usd", buyerEmail: newsletter.fromEmail, buyerName: newsletter.name, recipientEmail: contact.email, deliverOn: now, paidAt: now, expiresAt: getGiftExpiry(now), sentAt: now, status: "sent" });
			} catch (error) {
				if (error?.code !== 11000) throw error;
				gift = await Gift.findOne(scoped(account, { referralRewardId: receipt._id })).lean();
			}
		}
		if (!gift) return receipt;
		set = { giftId: gift._id };
	} else return receipt;
	set = { ...set, state: "ready", fulfilledAt: new Date() };
	const changed = await ReferralReward.updateOne(scoped(account, { _id: receipt._id, state: "pending" }), { $set: set });
	if (changed.matchedCount) await emitWebhookEvent({ accountId: account, newsletterId: newsletter._id, type: "referral_reward.fulfilled", data: { id: String(receipt._id), newsletterId: String(newsletter._id), rewardId: receipt.rewardId } });
	return { ...receipt, ...set };
}

export async function retryRewardBenefits({ newsletter, after }) {
	const receipts = await ReferralReward.find(scoped(newsletter.accountId, { newsletterId: newsletter._id, state: "pending", "benefit.kind": { $in: ["code", "gift"] }, ...(after && { _id: { $gt: after } }) })).sort({ _id: 1 }).limit(REFERRAL_FULFILL_BATCH + 1).lean();
	let ready = 0;
	for (const receipt of receipts.slice(0, REFERRAL_FULFILL_BATCH)) {
		const contact = await Contact.findOne(scoped(newsletter.accountId, { _id: receipt.contactId, newsletterId: newsletter._id })).lean();
		if ((await fulfillReward({ newsletter, receipt, contact })).state === "ready") ready++;
	}
	return { checked: Math.min(receipts.length, REFERRAL_FULFILL_BATCH), ready, nextCursor: receipts.length > REFERRAL_FULFILL_BATCH ? String(receipts[REFERRAL_FULFILL_BATCH - 1]._id) : null };
}

export async function readRewardBenefits({ newsletter, contact }) {
	if (contact.status !== "active") return [];
	const filter = scoped(newsletter.accountId, { newsletterId: newsletter._id, contactId: contact._id });
	const receipts = await ReferralReward.find(filter).sort({ _id: -1 }).limit(100).lean();
	const [codes, gifts] = await Promise.all([
		ReferralCode.find(scoped(newsletter.accountId, { receiptId: { $in: receipts.map((r) => r._id) } })).lean(),
		Gift.find(scoped(newsletter.accountId, { _id: { $in: receipts.map((r) => r.giftId).filter(Boolean) }, recipientEmail: contact.email })).lean(),
	]);
	return receipts.map((receipt) => ({
		...receipt,
		code: receipt.state === "ready" ? codes.find((code) => String(code._id) === String(receipt.codeId))?.code : null,
		giftUrl: receipt.state === "ready" && gifts.some((gift) => String(gift._id) === String(receipt.giftId)) ? getGiftRedeemUrl(gifts.find((gift) => String(gift._id) === String(receipt.giftId)), newsletter) : null,
	}));
}
