import "server-only";
import { codedError } from "@/lib/account-state";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { assertPaymentsReady, getChargeAccount } from "@/lib/payments/connect";
import { formatPrice } from "@/lib/payments/config";
import { getTierPriceId } from "@/lib/payments/tier-prices";
import { READER_RETENTION_VERSION } from "@/lib/reader-retention-rules";
import { stripeRequest } from "@/lib/payments/stripe-api";
import { getPaidTrialProblem } from "@/lib/paid-trial-rules";
import { getReaderText } from "@/lib/reader-languages";
import { resolveOffer } from "@/lib/offers";
import { assertFoundingSpot } from "@/lib/supporters";
import { OPTION_NOTES, findTier, getContactInterval, getNewsletterTiers, getOfferedTiers, getTierOptions } from "@/lib/tier-rules";
import { normalizeEmail } from "@/lib/validation";

// Every sale is a Stripe Checkout Session on the creator's own Stripe account (a direct charge): the buyer pays them, their
// payout and fees are Stripe's, and FlockStack sets no application fee, ever (lib/payments/stripe-api.js refuses one).
// metadata.flockstack marks what FlockStack made, so the webhook ignores the rest of the creator's Stripe account.
const DESCRIPTION_LIMIT = 500;

function baseMetadata({ account, newsletter, kind }) {
	return { flockstack: "1", kind, accountId: String(account._id), newsletterId: String(newsletter._id) };
}

// A reader subscribes to one of the newsletter's paid tiers: a Checkout Session on the creator's account for one of the
// tier's Prices (lib/payments/tier-prices.js), chosen from the newsletter's settings and never from the form. Lifetime is a
// single payment; the rest are subscriptions. The subscription carries the same metadata as the session, so its renewals and
// cancellations find their reader (lib/payments/subscriptions.js).
export async function createSubscriptionCheckout({ account, newsletter, tierId, option, email, offerCode }) {
	assertPaymentsReady(account);
	const tiers = getNewsletterTiers(newsletter);
	const tier = findTier(tiers, tierId ?? getOfferedTiers(tiers)[0]?.id);
	const way = tier && !tier.archived ? getTierOptions(tier).find((candidate) => candidate.option === option) : null;
	if (!newsletter.paidTier?.enabled || !way) throw codedError({ code: "conflict", message: "This newsletter doesn't offer that plan" });
	await assertFoundingSpot({ account, newsletter, tier });
	const offer = offerCode ? await resolveOffer({ account, newsletter, code: offerCode, tier }) : null;
	const trialProblem = getPaidTrialProblem(offer);
	if (trialProblem) throw codedError({ code: "conflict", message: trialProblem });
	const trialAmountCents = offer?.trialAmountCents ?? 0;
	if (trialAmountCents > 0 && (way.mode !== "subscription" || way.option === "pwyw")) throw codedError({ code: "conflict", message: "A paid trial requires a fixed recurring plan" });
	const priceId = await getTierPriceId({ account, newsletter, tier, option: way.option });
	if (!priceId) throw codedError({ code: "conflict", message: "This newsletter doesn't offer that plan" });

	const urls = getArchiveUrls(newsletter);
	const metadata = { ...baseMetadata({ account, newsletter, kind: "paid_tier" }), tierId: tier.id, option: way.option, interval: getContactInterval(tier, way.option), ...(offer && { offerId: String(offer._id) }), ...(trialAmountCents > 0 && { trialAmountCents: String(trialAmountCents), trialCurrency: offer.currency }) };
	const buyerEmail = normalizeEmail(email ?? "");
	const isSubscription = way.mode === "subscription";
	const flexible = isSubscription && newsletter.readerRetention?.pauseEnabled === true;
	// An offer can give its link a trial of its own, with or without a card up front.
	const trialDays = isSubscription ? (offer?.trialDays || newsletter.paidTier.trialDays || 0) : 0;
	const t = getReaderText(newsletter);
	const trialNoCard = trialAmountCents > 0 ? false : (offer?.trialNoCard ?? newsletter.paidTier.trialNoCard);
	const session = await stripeRequest("/v1/checkout/sessions", {
		method: "POST",
		account: getChargeAccount(account),
		...(flexible && { apiVersion: READER_RETENTION_VERSION }),
		params: {
			mode: way.mode,
			line_items: [{ quantity: 1, price: priceId }, ...(trialAmountCents > 0 ? [{ quantity: 1, price_data: { currency: offer.currency, unit_amount: trialAmountCents, product_data: { name: `${newsletter.name}: ${trialDays}-day trial access`.slice(0, 200) } } }] : [])],
			...(trialAmountCents > 0 && { payment_method_types: ["card"], payment_method_collection: "always" }),
			metadata,
			...(isSubscription
				? {
						subscription_data: {
							metadata,
							...(flexible && { billing_mode: { type: "flexible" } }),
							...(trialDays > 0 && { trial_period_days: trialDays }),
							...(trialDays > 0 && trialNoCard && { trial_settings: { end_behavior: { missing_payment_method: "cancel" } } }),
						},
						...(trialDays > 0 && trialNoCard && { payment_method_collection: "if_required" }),
					}
				: { payment_intent_data: { metadata } }),
			...(buyerEmail && { customer_email: buyerEmail }),
			// Stripe takes a coupon or the box for a promotion code, not both.
			...(trialAmountCents > 0 ? { allow_promotion_codes: false } : offer?.stripeCouponId ? { discounts: [{ coupon: offer.stripeCouponId }] } : { allow_promotion_codes: true }),
			// A founding member can ask to be on the supporters list, by the name they give here.
			...(tier.founding.enabled && newsletter.paidTier.supportersPublic && {
				custom_fields: [{ key: "supportername", label: { type: "custom", custom: "Name for the supporters list" }, type: "text", optional: true, text: { maximum_length: 60 } }],
			}),
			custom_text: {
				submit: {
					message: isSubscription
						? trialAmountCents > 0 ? t("Pay {fee} now for {days} days of trial access, then {price} {interval}. Renews until canceled.", { fee: formatPrice(trialAmountCents, offer.currency, t.language), days: trialDays, price: formatPrice(way.cents, offer.currency, t.language), interval: t(OPTION_NOTES[way.option]) }) + " " + t("You pay through Stripe. Cancel anytime from the link at the bottom of each email.") : `You'll get every issue of ${newsletter.name} by email, the paid ones included. Cancel anytime from the link at the bottom of each email.`
						: `You'll get every issue of ${newsletter.name} by email, the paid ones included, and it never renews.`,
				},
			},
			success_url: `${urls.absoluteSubscribe}?paid=1`,
			cancel_url: urls.absoluteSubscribe,
		},
	});
	return { id: session.id, url: session.url };
}

// Stripe's customer portal needs a configuration, which a creator who never opened it has not made: the first time, it is made
// here with what a reader needs (their card, their invoices, cancelling at the period's end).
async function ensurePortalConfiguration(stripeAccount) {
	const { data } = await stripeRequest("/v1/billing_portal/configurations", { account: stripeAccount, params: { is_default: true, limit: 1 } });
	if (data.length > 0) return;
	await stripeRequest("/v1/billing_portal/configurations", {
		method: "POST",
		account: stripeAccount,
		params: {
			business_profile: { headline: "Manage your subscription" },
			features: {
				invoice_history: { enabled: true },
				payment_method_update: { enabled: true },
				customer_update: { enabled: true, allowed_updates: ["email", "name"] },
				subscription_cancel: { enabled: true, mode: "at_period_end" },
			},
		},
	});
}

// A paid reader's billing page at Stripe, on the creator's account: they update their card, read invoices or cancel.
export async function createBillingPortalSession({ account, customerId, returnUrl }) {
	assertPaymentsReady(account);
	const stripeAccount = getChargeAccount(account);
	await ensurePortalConfiguration(stripeAccount);
	const session = await stripeRequest("/v1/billing_portal/sessions", { method: "POST", account: stripeAccount, params: { customer: customerId, return_url: returnUrl } });
	return session.url;
}

export async function createProductCheckout({ account, newsletter, product, email, addToList = false }) {
	assertPaymentsReady(account);
	if (product.status !== "active" || !product.file?.key) throw codedError({ code: "conflict", message: "This product isn't for sale" });
	const urls = getArchiveUrls(newsletter);
	const metadata = { ...baseMetadata({ account, newsletter, kind: "product" }), productId: String(product._id), addToList: addToList ? "1" : "0" };
	const buyerEmail = normalizeEmail(email ?? "");
	const session = await stripeRequest("/v1/checkout/sessions", {
		method: "POST",
		account: getChargeAccount(account),
		params: {
			mode: "payment",
			line_items: [
				{
					quantity: 1,
					price_data: {
						currency: product.currency,
						unit_amount: product.priceCents,
						product_data: {
							name: product.title,
							...(product.description && { description: product.description.slice(0, DESCRIPTION_LIMIT) }),
							...(product.imageUrl?.startsWith("https://") && { images: [product.imageUrl] }),
						},
					},
				},
			],
			metadata,
			payment_intent_data: { metadata, description: `${product.title} (${newsletter.name})` },
			...(buyerEmail && { customer_email: buyerEmail }),
			custom_text: { submit: { message: "The download link comes to your email as soon as you've paid." } },
			success_url: `${urls.absoluteProduct(product.slug)}?paid=1`,
			cancel_url: urls.absoluteProduct(product.slug),
		},
	});
	return { id: session.id, url: session.url };
}
