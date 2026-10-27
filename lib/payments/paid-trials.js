import "server-only";
import { hasPaidTrialInvoice } from "@/lib/paid-trial-rules";
import { getChargeAccount } from "@/lib/payments/connect";
import { stripeRequest } from "@/lib/payments/stripe-api";

// A trialing subscription alone proves no upfront payment. Always use its current initial invoice from Stripe.
export async function isPaidTrialReady({ account, subscription }) {
	if (subscription.status !== "trialing" || !Object.hasOwn(subscription.metadata ?? {}, "trialAmountCents")) return true;
	let invoice = subscription.latest_invoice;
	if (typeof invoice === "string") invoice = await stripeRequest(`/v1/invoices/${encodeURIComponent(invoice)}`, { account: getChargeAccount(account) });
	return hasPaidTrialInvoice(subscription, invoice);
}
