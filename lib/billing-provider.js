import "server-only";
import { syncPolarCheckout } from "@/lib/billing-polar";
import { syncCheckoutSession } from "@/lib/billing";
import * as polar from "@/lib/polar";
import * as stripe from "@/lib/stripe";

// Who bills the plans, chosen by what the server has keys for: Polar when POLAR_ACCESS_TOKEN is set, else Stripe when
// STRIPE_SECRET_KEY is, else "none": plans can't be bought yet. The rest of the app asks here, never the providers.
export function getBillingProvider(env = process.env) {
	if (env.POLAR_ACCESS_TOKEN) return "polar";
	if (env.STRIPE_SECRET_KEY) return "stripe";
	return "none";
}

export function isBillingConfigured() {
	return getBillingProvider() !== "none";
}

// For the billing page's notices and the API's errors.
export function getBillingProviderName() {
	return getBillingProvider() === "polar" ? "Polar" : "Stripe";
}

export function hasBillingCustomer(account) {
	return Boolean(getBillingProvider() === "polar" ? account?.polarCustomerId : account?.stripeCustomerId);
}

export function findPlansOnSale() {
	return getBillingProvider() === "polar" ? polar.findPlansOnSale() : stripe.findPlansOnSale();
}

export function createCheckoutSession(options) {
	return getBillingProvider() === "polar" ? polar.createCheckoutSession(options) : stripe.createCheckoutSession(options);
}

export function createPortalSession(options) {
	return getBillingProvider() === "polar" ? polar.createPortalSession(options) : stripe.createPortalSession(options);
}

// Checkout's success URL: Stripe sends the session, Polar sends the account back and its subscriptions are read.
export function syncCheckoutReturn({ account, params }) {
	if (getBillingProvider() === "polar") return syncPolarCheckout({ account });
	const sessionId = params.get("session_id");
	return sessionId ? syncCheckoutSession({ account, sessionId }) : null;
}
