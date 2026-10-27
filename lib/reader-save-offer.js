import "server-only";
import { createHash } from "node:crypto";
import { scoped } from "@/lib/account-scope";
import { actionError } from "@/lib/actions/errors";
import { getOfferProblem } from "@/lib/offer-rules";
import { assertKnownRetentionCreation, assertReaderRetentionWrite, claimReaderRetention, finishReaderRetention, readCurrentReaderBilling, readerRetentionStripeRequest } from "@/lib/reader-retention-store";
import Offer from "@/models/Offer";

const ref = value => typeof value === "string" ? value : value?.id ?? null;
const conflict = message => actionError("conflict", message);
const couponId = discount => ref(discount?.source?.coupon ?? discount?.coupon);
const hasDiscounts = subscription => (subscription.discounts?.length ?? 0) > 0 || (subscription.items?.data ?? []).some(item => item.discounts?.length);
const appliedCoupon = (subscription, id) => (subscription.discounts ?? []).some(discount => couponId(discount) === id);

function saveProblem(context) {
	if (context.contact.status !== "active") return "This address is no longer subscribed. You can still pause or cancel its billing, or manage it in Stripe.";
	if (!context.details.supported || context.subscription.status !== "active") return "Only an active personal recurring subscription can accept a save offer";
	if (context.details.scheduleId || context.subscription.pending_update || context.subscription.pause_collection || context.subscription.cancel_at && !context.subscription.cancel_at_period_end) return "Resolve the subscription's schedule or pending billing changes before accepting a save offer";
	if (hasDiscounts(context.subscription)) return "This subscription already has a discount. FlockStack won't replace or stack it.";
	if (context.record?.saveUsedAt) return "This subscription has already used its one-time save offer";
	return null;
}

export async function readReaderSaveOffer(context) {
	const problem = saveProblem(context);
	if (problem) return { available: false, problem, offer: null };
	const selected = context.newsletter.readerRetention?.saveOfferId;
	if (!selected) return { available: false, problem: "The creator hasn't selected a save offer", offer: null };
	const offer = await Offer.findOne(scoped(context.account, { _id: selected, newsletterId: context.newsletter._id })).lean();
	if (!offer || !["percent", "amount"].includes(offer.type) || offer.trialDays > 0 || offer.trialAmountCents > 0 || getOfferProblem(offer, { currency: context.details.currency }) || !offer.stripeCouponId || !/^[A-Za-z0-9_-]{1,180}$/.test(offer.stripeCouponId)) return { available: false, problem: "The creator's save offer isn't available", offer: null };
	const tierId = context.subscription.metadata.tierId ?? context.contact.paidPersonal?.tierId ?? "paid";
	if (offer.tierIds?.length && !offer.tierIds.includes(tierId)) return { available: false, problem: "This save offer is for another tier", offer: null };
	const coupon = await readerRetentionStripeRequest(context.account, `/v1/coupons/${offer.stripeCouponId}`);
	const valid = coupon?.id === offer.stripeCouponId && coupon.metadata?.flockstack === "1" && coupon.metadata.offerId === String(offer._id) && coupon.metadata.newsletterId === String(context.newsletter._id) && coupon.valid === true && coupon.duration === offer.duration && (offer.duration !== "repeating" || Number(coupon.duration_in_months) === offer.durationMonths) && (offer.type === "percent" ? Number(coupon.percent_off) === offer.percentOff && coupon.amount_off == null : Number(coupon.amount_off) === offer.amountOffCents && coupon.currency === offer.currency) && (coupon.redeem_by == null || Number.isSafeInteger(Number(coupon.redeem_by)) && Number(coupon.redeem_by) * 1000 > Date.now()) && (coupon.max_redemptions == null || Number.isSafeInteger(Number(coupon.max_redemptions)) && Number(coupon.max_redemptions) > 0 && Number.isSafeInteger(Number(coupon.times_redeemed)) && Number(coupon.times_redeemed) < Number(coupon.max_redemptions));
	if (!valid) return { available: false, problem: "Stripe hasn't confirmed the creator's current save offer", offer: null };
	const terms = { id: String(offer._id), name: offer.name, type: offer.type, percentOff: offer.percentOff ?? null, amountOffMinor: offer.amountOffCents ?? null, currency: offer.type === "amount" ? offer.currency : context.details.currency, duration: offer.duration, durationMonths: offer.durationMonths ?? null, expiresAt: offer.expiresAt ? new Date(offer.expiresAt).toISOString() : null };
	return { available: true, problem: null, offer: { ...terms, hash: createHash("sha256").update(JSON.stringify(terms)).digest("hex") }, couponId: coupon.id };
}

export async function acceptReaderSaveOffer({ account, newsletterId, contactId, externalId, offerId, expectedHash, confirm = false }) {
	if (confirm !== true) throw actionError("validation_failed", "Confirm the creator's displayed save offer and continued subscription");
	let context = await readCurrentReaderBilling({ account, newsletterId, contactId });
	const retry = context.record?.pending?.kind === "save" && context.record.pending.externalId === externalId;
	const duplicate = context.record?.lastKind === "save" && context.record.lastExternalId === externalId;
	let choice;
	const alreadyApplied = retry && context.record.pending.couponId && appliedCoupon(context.subscription, context.record.pending.couponId);
	if (!duplicate && !alreadyApplied) {
		choice = await readReaderSaveOffer(context);
		if (!choice.available) throw conflict(choice.problem);
		if (choice.offer.id !== String(offerId) || choice.offer.hash !== expectedHash) throw conflict("The save offer changed. Review its current terms before accepting.");
	}
	const claimed = await claimReaderRetention(context, { kind: "save", externalId, request: { offerId, expectedHash, confirm: true }, params: choice ? { discounts: [{ coupon: choice.couponId }], cancel_at_period_end: false, proration_behavior: "none" } : undefined, extra: choice ? { couponId: choice.couponId, offerId: choice.offer.id } : {} });
	if (claimed.duplicate) return { context, record: claimed.record, duplicate: true };
	if (!appliedCoupon(context.subscription, claimed.record.pending.couponId)) {
		assertKnownRetentionCreation(claimed.record);
		if (!choice || String(context.newsletter.readerRetention?.saveOfferId) !== String(claimed.record.pending.offerId) || choice.couponId !== claimed.record.pending.couponId) throw conflict("The creator changed this save offer before it could be applied");
		await assertReaderRetentionWrite(context, claimed, { requireOfferId: claimed.record.pending.offerId });
		const current = await readerRetentionStripeRequest(context.account, `/v1/subscriptions/${context.subscription.id}`, { method: "POST", idempotencyKey: `flockstack-reader-save-${claimed.record._id}-${externalId}`, params: claimed.record.pending.params });
		if (current?.id !== context.subscription.id || ref(current.customer) !== context.details.customerId) throw conflict("Stripe returned another reader's subscription");
	}
	context = await readCurrentReaderBilling({ account: context.account, newsletterId, contactId });
	if (!appliedCoupon(context.subscription, claimed.record.pending.couponId) || context.subscription.cancel_at_period_end || context.subscription.cancel_at) throw conflict("Stripe hasn't confirmed both the save offer and continued subscription");
	const record = await finishReaderRetention(context.account, claimed, { saveCouponId: claimed.record.pending.couponId, saveOfferId: claimed.record.pending.offerId, saveUsedAt: new Date(), observedSubscriptionStatus: context.subscription.status });
	return { context, record, duplicate: false };
}
