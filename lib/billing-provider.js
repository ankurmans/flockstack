import "server-only";

// The two providers' code (Stripe's SDK is 300 KB) loads when a plan is priced, a checkout or a portal is opened, not with the
// dashboard's layout, which only asks which provider there is.
const loadPolar = () => import("@/lib/polar");
const loadStripe = () => import("@/lib/stripe");

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

export async function findPlansOnSale() {
	return (getBillingProvider() === "polar" ? await loadPolar() : await loadStripe()).findPlansOnSale();
}

export async function createCheckoutSession(options) {
	return (getBillingProvider() === "polar" ? await loadPolar() : await loadStripe()).createCheckoutSession(options);
}

export async function createPortalSession(options) {
	return (getBillingProvider() === "polar" ? await loadPolar() : await loadStripe()).createPortalSession(options);
}

// Checkout's success URL: Stripe sends the session, Polar sends the account back and its subscriptions are read.
export async function syncCheckoutReturn({ account, params }) {
	if (getBillingProvider() === "polar") return (await import("@/lib/billing-polar")).syncPolarCheckout({ account });
	const sessionId = params.get("session_id");
	return sessionId ? (await import("@/lib/billing")).syncCheckoutSession({ account, sessionId }) : null;
}
