import "server-only";
import { scoped } from "@/lib/account-scope";
import { getChargeAccount } from "@/lib/payments/connect";
import { stripeRequest } from "@/lib/payments/stripe-api";
import { LEGACY_TIER_ID, getBillingInterval, getNewsletterTiers, getTierOptions } from "@/lib/tier-rules";
import Newsletter from "@/models/Newsletter";

// Each tier is a Product on the creator's own Stripe account with one Price per way to pay, so their dashboard, invoices and
// customer portal show real products. A Price's amount can't change: a new amount makes a new Price and retires the old one,
// and readers already subscribed keep the Price they signed up on. What was made is kept on the tier (tier.stripe), so a
// repeat creates nothing.
function getProductName(newsletter, tier) {
	return `${newsletter.name}, ${tier.id === LEGACY_TIER_ID ? "paid subscription" : tier.name}`.slice(0, 250);
}

function describeWanted(option, newsletter, tier) {
	const currency = newsletter.paidTier?.currency || "usd";
	const isPwyw = option.option === "pwyw";
	return { key: `${option.cents}:${currency}:${isPwyw ? tier.pwyw.interval : ""}`, currency, isPwyw };
}

function priceParams({ product, option, tier, currency, isPwyw }) {
	const recurring = getBillingInterval(tier, option.option);
	return {
		product,
		currency,
		...(isPwyw ? { custom_unit_amount: { enabled: true, minimum: option.cents, preset: option.cents } } : { unit_amount: option.cents }),
		...(recurring && { recurring }),
		metadata: { flockstack: "1", tierId: tier.id, option: option.option },
	};
}

// Makes the tier's Product and Prices on the creator's account where they are missing or out of date. Returns the tier's
// `stripe` record; the caller saves it (saveTierStripe).
export async function syncTierWithStripe({ account, newsletter, tier }) {
	const stripeAccount = getChargeAccount(account);
	const stripe = { ...tier.stripe, prices: { ...tier.stripe?.prices } };
	const name = getProductName(newsletter, tier);
	if (!stripe.productId) {
		const product = await stripeRequest("/v1/products", {
			method: "POST",
			account: stripeAccount,
			idempotencyKey: `flockstack-tier-${newsletter._id}-${tier.id}`,
			params: {
				name,
				...(tier.description && { description: tier.description.slice(0, 500) }),
				metadata: { flockstack: "1", accountId: String(account._id), newsletterId: String(newsletter._id), tierId: tier.id },
			},
		});
		stripe.productId = product.id;
		stripe.productName = name;
	} else if (stripe.productName !== name) {
		await stripeRequest(`/v1/products/${stripe.productId}`, { method: "POST", account: stripeAccount, params: { name } });
		stripe.productName = name;
	}

	const wanted = new Map(getTierOptions(tier).map((option) => [option.option, option]));
	for (const [optionName, option] of wanted) {
		const { key, currency, isPwyw } = describeWanted(option, newsletter, tier);
		const existing = stripe.prices[optionName];
		if (existing?.key === key) continue;
		const price = await stripeRequest("/v1/prices", {
			method: "POST",
			account: stripeAccount,
			idempotencyKey: `flockstack-price-${newsletter._id}-${tier.id}-${optionName}-${key}-${existing?.id ?? "first"}`,
			params: priceParams({ product: stripe.productId, option, tier, currency, isPwyw }),
		});
		stripe.prices[optionName] = { id: price.id, key };
		if (existing) await retirePrice(stripeAccount, existing.id);
	}
	for (const [optionName, existing] of Object.entries(stripe.prices)) {
		if (wanted.has(optionName)) continue;
		await retirePrice(stripeAccount, existing.id);
		delete stripe.prices[optionName];
	}
	return stripe;
}

// A retired Price can't be picked for a new subscription; the ones already on it carry on.
async function retirePrice(stripeAccount, priceId) {
	await stripeRequest(`/v1/prices/${priceId}`, { method: "POST", account: stripeAccount, params: { active: false } }).catch((error) => {
		console.error(`[tiers] Retiring price ${priceId} failed:`, error.message);
	});
}

// Stores the tiers on the newsletter, in this order. A newsletter from before tiers gets its one tier written out here.
export async function saveTiers(account, newsletter, tiers) {
	await Newsletter.updateOne(scoped(account, { _id: newsletter._id }), { $set: { paidTiers: tiers } });
}

export async function saveTierStripe(account, newsletter, tierId, stripe) {
	const tiers = getNewsletterTiers(await Newsletter.findOne(scoped(account, { _id: newsletter._id })).lean()).map((tier) => (tier.id === tierId ? { ...tier, stripe } : tier));
	await saveTiers(account, newsletter, tiers);
	return tiers.find((tier) => tier.id === tierId);
}

// The Price a checkout for one way to pay asks for, made now when the tier has none yet (a newsletter from before tiers).
export async function getTierPriceId({ account, newsletter, tier, option }) {
	const known = tier.stripe?.prices?.[option];
	const wanted = getTierOptions(tier).find((candidate) => candidate.option === option);
	if (!wanted) return null;
	const { key } = describeWanted(wanted, newsletter, tier);
	if (known?.key === key) return known.id;
	const stripe = await syncTierWithStripe({ account, newsletter, tier });
	await saveTierStripe(account, newsletter, tier.id, stripe);
	return stripe.prices[option]?.id ?? null;
}

// The Product's description follows the tier's.
export async function updateTierProductDescription({ account, tier }) {
	if (!tier.stripe?.productId) return;
	await stripeRequest(`/v1/products/${tier.stripe.productId}`, { method: "POST", account: getChargeAccount(account), params: { description: tier.description || "" } });
}

// A deleted tier's Product stays in Stripe for the invoices it made, but can't be sold.
export async function retireTierProduct({ account, tier }) {
	const stripeAccount = getChargeAccount(account);
	for (const { id } of Object.values(tier.stripe?.prices ?? {})) await retirePrice(stripeAccount, id);
	if (tier.stripe?.productId) {
		await stripeRequest(`/v1/products/${tier.stripe.productId}`, { method: "POST", account: stripeAccount, params: { active: false } }).catch((error) => {
			console.error(`[tiers] Retiring product ${tier.stripe.productId} failed:`, error.message);
		});
	}
}

// The tier's Product on the creator's account, made now when the tier has none: a charge at a price of its own (a pledge's)
// still belongs to the tier's Product.
export async function getTierProductId({ account, newsletter, tier }) {
	if (tier.stripe?.productId) return tier.stripe.productId;
	const stripe = await syncTierWithStripe({ account, newsletter, tier });
	await saveTierStripe(account, newsletter, tier.id, stripe);
	return stripe.productId;
}
