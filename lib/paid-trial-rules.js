import { CURRENCIES, MAX_PRICE_CENTS } from "./payments/config.js";

export const MAX_TRIAL_DAYS = 90;

// Stripe's settlement minimums vary. These bounds also keep the app's existing one-unit floor for other currencies.
export function getTrialMinimumCents(currency) {
	return { dkk: 250, nok: 300, sek: 300 }[currency] ?? 100;
}

export function getPaidTrialProblem(offer) {
	if (offer?.trialAmountCents === undefined || offer.trialAmountCents === 0) return null;
	if (offer.type !== "trial" || !CURRENCIES.includes(offer.currency) || !Number.isSafeInteger(offer.trialAmountCents) || offer.trialAmountCents < getTrialMinimumCents(offer.currency) || offer.trialAmountCents > MAX_PRICE_CENTS || !Number.isInteger(offer.trialDays) || offer.trialDays < 1 || offer.trialDays > MAX_TRIAL_DAYS || offer.trialNoCard === true) return "This paid trial's terms are invalid";
	return null;
}

export function hasPaidTrialInvoice(subscription, invoice) {
	const metadata = subscription.metadata ?? {};
	const amount = Number(metadata.trialAmountCents);
	if (!Number.isSafeInteger(amount) || amount < getTrialMinimumCents(metadata.trialCurrency) || amount > MAX_PRICE_CENTS || !CURRENCIES.includes(metadata.trialCurrency)) return false;
	const reference = invoice?.subscription ?? invoice?.parent?.subscription_details?.subscription;
	const subscriptionId = typeof reference === "string" ? reference : reference?.id;
	return Boolean(invoice && invoice.status === "paid" && invoice.billing_reason === "subscription_create" && subscriptionId === subscription.id && invoice.currency === metadata.trialCurrency && Number.isSafeInteger(invoice.amount_paid) && invoice.amount_paid >= amount);
}
