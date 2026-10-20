import "server-only";
import { scoped } from "@/lib/account-scope";
import { actionError } from "@/lib/actions/errors";
import { getPaymentsState } from "@/lib/payments/connect";
import { StripeError } from "@/lib/payments/stripe-api";
import { saveTiers, syncTierWithStripe } from "@/lib/payments/tier-prices";
import { LEGACY_TIER_ID, findTier, getNewsletterTiers, getOfferedTiers } from "@/lib/tier-rules";
import { audienceTierFilter } from "@/lib/tiers";
import { tierIdFilter } from "@/lib/tier-rules";
import Contact from "@/models/Contact";
import Newsletter from "@/models/Newsletter";

const STRIPE_PAYING = ["active", "trialing"];

// Active contacts who are paid in a tier now, with how many of them are there by a comp or a gift, not by paying.
export async function countTierReaders(account, newsletter, tierId) {
	const base = scoped(account, { newsletterId: newsletter._id, status: "active", ...audienceTierFilter("paid", Date.now(), tierIdFilter([tierId])) });
	const grantOnly = (kind) => ({ ...base, "grant.kind": kind, subscriptionStatus: { $nin: STRIPE_PAYING } });
	const [total, comp, gift] = await Promise.all([Contact.countDocuments(base), Contact.countDocuments(grantOnly("comp")), Contact.countDocuments(grantOnly("gift"))]);
	return { total, paying: Math.max(0, total - comp - gift), comp, gift };
}

// Active paid contacts of a newsletter by how they are paid: paying (a subscription or a lifetime payment, a trial included),
// on a comp the writer gave, or on a gift.
export async function countPaidAccess(account, newsletter) {
	const base = scoped(account, { newsletterId: newsletter._id, status: "active", ...audienceTierFilter("paid") });
	const grantOnly = (kind) => ({ ...base, "grant.kind": kind, subscriptionStatus: { $nin: STRIPE_PAYING } });
	const [total, comp, gift] = await Promise.all([Contact.countDocuments(base), Contact.countDocuments(grantOnly("comp")), Contact.countDocuments(grantOnly("gift"))]);
	return { total, comp, gift, paying: Math.max(0, total - comp - gift) };
}

// What the tiers bring in a month at their list prices, from the readers who pay: comps and gifts bring in nothing, a lifetime
// payment is not recurring, and a discount or a price that has changed since isn't counted, so it is an estimate.
export async function estimateMonthlyRevenue(account, newsletter, tier) {
	const base = scoped(account, { newsletterId: newsletter._id, status: "active", ...audienceTierFilter("paid", Date.now(), tierIdFilter([tier.id])) });
	const [month, quarter, year] = await Promise.all(["month", "quarter", "year"].map((interval) => Contact.countDocuments({ ...base, paidInterval: interval })));
	const cents = month * tier.prices.month + (quarter * tier.prices.quarter) / 3 + (year * tier.prices.year) / 12;
	return { monthlyCents: Math.round(cents), monthly: month, quarterly: quarter, yearly: year };
}

// Every contact that has ever held a tier, whatever their state: a tier they hold can't be deleted under them.
export async function hasTierHolders(account, newsletter, tierId) {
	const filter = tierId === LEGACY_TIER_ID ? { $or: [{ paidTierId: tierId }, { paidTierId: null, tier: "paid" }] } : { paidTierId: tierId };
	return Boolean(await Contact.exists(scoped(account, { newsletterId: newsletter._id, ...filter })));
}

// Writes the tiers and keeps the newsletter's older price fields (paidTier.monthlyCents and yearlyCents) on the lowest tier
// readers can pick, which is what a client from before tiers reads.
export async function storeTiers(account, newsletter, tiers) {
	await saveTiers(account, newsletter, tiers);
	const lowest = getOfferedTiers(tiers)[0];
	await Newsletter.updateOne(scoped(account, { _id: newsletter._id }), {
		$set: { "paidTier.monthlyCents": lowest?.prices.month ?? 0, "paidTier.yearlyCents": lowest?.prices.year ?? 0 },
	});
}

// Makes a tier's Stripe Product and Prices when payments can take a sale and the paid tier is on; otherwise they are made at the
// first checkout. A Stripe that can't be reached fails the change: nothing is half done.
export async function syncTierIfLive({ account, newsletter, tier }) {
	if (!newsletter.paidTier?.enabled || !getPaymentsState(account).ready) return tier;
	try {
		return { ...tier, stripe: await syncTierWithStripe({ account, newsletter, tier }) };
	} catch (error) {
		if (!(error instanceof StripeError)) throw error;
		console.error("[tiers] Stripe didn't take the tier:", error.message);
		throw actionError("unavailable", "Stripe can't be reached right now. Try again in a minute.");
	}
}

export function requireTier(newsletter, reference) {
	const tiers = getNewsletterTiers(newsletter);
	const wanted = String(reference ?? "").trim().toLowerCase();
	const tier = findTier(tiers, wanted) ?? tiers.find((candidate) => candidate.name.toLowerCase() === wanted);
	if (!tier) throw actionError("not_found", "Paid tier not found");
	return { tier, tiers };
}
