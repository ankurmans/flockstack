import { isCloud } from "../config.js";

// Payments for what a creator sells (products, paid subscriptions) are apart from FlockStack's own plan billing
// (lib/billing-provider.js). On FlockStack Cloud each creator connects their own Stripe account (Stripe Connect,
// Standard accounts) and the platform key only opens those connections; a self-hosted server charges with its owner's
// own key. Either way the money goes to the creator's Stripe account and FlockStack keeps none of it.
export function getPaymentsSecretKey(env = process.env) {
	const connectKey = isCloud(env) ? String(env.STRIPE_CONNECT_SECRET_KEY ?? "").trim() : "";
	return connectKey || String(env.STRIPE_SECRET_KEY ?? "").trim() || null;
}

// connect: creators connect their own Stripe accounts. direct: this server's own key charges. none: not set up.
export function getPaymentsMode(env = process.env) {
	if (!getPaymentsSecretKey(env)) return "none";
	return isCloud(env) ? "connect" : "direct";
}

export function getPaymentsWebhookSecret(env = process.env) {
	return String(env.STRIPE_PAYMENTS_WEBHOOK_SECRET ?? "").trim() || null;
}

// Stripe's smallest charge is about 50 cents; other currencies differ a little, so this is a safe floor for all of them.
export const MIN_PRICE_CENTS = 100;
export const MAX_PRICE_CENTS = 99_999_900;

// Zero-decimal currencies would break the cents maths, so the list is closed to common two-decimal ones.
export const CURRENCIES = ["usd", "eur", "gbp", "cad", "aud", "nzd", "chf", "sek", "nok", "dkk"];

export function formatPrice(cents, currency = "usd") {
	return new Intl.NumberFormat("en-US", { style: "currency", currency: String(currency).toUpperCase() }).format(cents / 100);
}
