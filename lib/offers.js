import "server-only";
import { scoped } from "@/lib/account-scope";
import { codedError } from "@/lib/account-state";
import { connectDb } from "@/lib/db";
import { getOfferProblem } from "@/lib/offer-rules";
import { getChargeAccount } from "@/lib/payments/connect";
import { stripeRequest } from "@/lib/payments/stripe-api";
import Contact from "@/models/Contact";
import Offer from "@/models/Offer";

// A discount is a coupon on the creator's own Stripe account, applied to a Checkout Session by the offer's link; Stripe
// enforces its redemption limit and expiry. A coupon's terms can't change in Stripe, so an offer's can't either: a new
// offer replaces it.
export function findOfferByCode(newsletter, code) {
	return Offer.findOne(scoped(newsletter.accountId, { newsletterId: newsletter._id, code: String(code ?? "").toLowerCase() })).lean();
}

// Readers who signed up through the offer. Counted from the contacts, so a repeat of a Checkout event can't count twice.
export function countRedemptions(account, offer) {
	return Contact.countDocuments(scoped(account, { newsletterId: offer.newsletterId, offerId: String(offer._id) }));
}

export async function createCoupon({ account, offer }) {
	if (offer.type === "trial") return null;
	const coupon = await stripeRequest("/v1/coupons", {
		method: "POST",
		account: getChargeAccount(account),
		idempotencyKey: `flockstack-coupon-${offer._id}`,
		params: {
			name: offer.name.slice(0, 40),
			duration: offer.duration,
			...(offer.duration === "repeating" && { duration_in_months: offer.durationMonths }),
			...(offer.type === "percent" ? { percent_off: offer.percentOff } : { amount_off: offer.amountOffCents, currency: offer.currency }),
			...(offer.maxRedemptions && { max_redemptions: offer.maxRedemptions }),
			...(offer.expiresAt && { redeem_by: Math.floor(new Date(offer.expiresAt).getTime() / 1000) }),
			metadata: { flockstack: "1", offerId: String(offer._id), newsletterId: String(offer.newsletterId) },
		},
	});
	return coupon.id;
}

export async function deleteCoupon({ account, offer }) {
	if (!offer.stripeCouponId) return;
	await stripeRequest(`/v1/coupons/${offer.stripeCouponId}`, { method: "DELETE", account: getChargeAccount(account) }).catch((error) => {
		console.error(`[offers] Deleting coupon ${offer.stripeCouponId} failed:`, error.message);
	});
}

// The offer a checkout asks for, or the words for why it can't have it. tier: the tier being bought.
export async function resolveOffer({ account, newsletter, code, tier }) {
	const offer = await findOfferByCode(newsletter, code);
	const redemptions = offer ? await countRedemptions(account, offer) : 0;
	const problem = getOfferProblem(offer, { redemptions, currency: newsletter.paidTier?.currency || "usd" });
	if (problem) throw codedError({ code: "conflict", message: problem });
	if (offer.tierIds?.length && !offer.tierIds.includes(tier.id)) throw codedError({ code: "conflict", message: "This offer is for another tier" });
		return offer;
}

// The launch offer banner: shown while the paid tier is open and the offer behind it (if any) still works.
export async function getLaunchBanner(newsletter) {
	const banner = newsletter.paidTier?.banner;
	if (!banner?.enabled || !banner.text || !newsletter.paidTier?.enabled) return null;
	if (!banner.offerId) return { text: banner.text, offerCode: null };
	await connectDb();
	const offer = await Offer.findOne(scoped(newsletter.accountId, { _id: banner.offerId })).lean();
	if (!offer || getOfferProblem(offer, { currency: newsletter.paidTier?.currency || "usd", redemptions: offer.maxRedemptions ? await countRedemptions(newsletter.accountId, offer) : 0 })) return null;
	return { text: banner.text, offerCode: offer.code };
}
