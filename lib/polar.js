import "server-only";
import { getAppUrl } from "@/lib/config";
import { DEDICATED_IP_PRICE, INTERVALS, PLANS, getPlan, getPrice } from "@/lib/plans";
import {
	ADDON_METADATA,
	DEDICATED_IP_ADDON,
	POLAR_API_VERSION,
	getProductKey,
	isPricedRight,
} from "@/lib/polar-catalog";

export { ADDON_METADATA, DEDICATED_IP_ADDON, EXTRA_EMAILS_EVENT, hasExtraEmailsPrice } from "@/lib/polar-catalog";

// Products are found by their metadata, flockstack_plan (starter, growth…) and interval (month, year), and refused when
// Polar and lib/plans.js disagree on the fixed amount (lib/polar-catalog.js). A plan's product also carries the extra
// emails metered price. The dedicated IP add-on is one monthly product whatever the plan: flockstack_addon and
// interval, no plan. scripts/polar-setup.mjs creates them all.

const PLANS_ON_SALE_MS = 10 * 60_000;
const PLANS_ON_SALE_RETRY_MS = 60_000;
const PRODUCTS_PER_PAGE = 100;
const MAX_PRODUCT_PAGES = 10;
const REQUEST_TIMEOUT_MS = 8000;
const LIST_TIMEOUT_MS = 5000;

let products = null;
let failedUntil = 0;

export function isPolarConfigured() {
	return Boolean(process.env.POLAR_ACCESS_TOKEN);
}

// The sandbox is a separate Polar with its own organization, token, products and webhook secret.
export function getPolarBase(env = process.env) {
	return env.POLAR_SERVER === "sandbox" ? "https://sandbox-api.polar.sh" : "https://api.polar.sh";
}

export class PolarError extends Error {
	constructor(message, status) {
		super(message);
		this.status = status;
	}
}

export async function polarRequest(path, { method = "GET", body, query, timeout = REQUEST_TIMEOUT_MS } = {}) {
	if (!isPolarConfigured()) throw new Error("Polar is not configured (POLAR_ACCESS_TOKEN)");
	const search = query ? `?${new URLSearchParams(query)}` : "";
	const response = await fetch(`${getPolarBase()}${path}${search}`, {
		method,
		headers: {
			authorization: `Bearer ${process.env.POLAR_ACCESS_TOKEN}`,
			accept: "application/json",
			"polar-version": POLAR_API_VERSION,
			...(body !== undefined && { "content-type": "application/json" }),
		},
		...(body !== undefined && { body: JSON.stringify(body) }),
		signal: AbortSignal.timeout(timeout),
	});
	if (!response.ok) {
		const detail = (await response.text().catch(() => "")).slice(0, 300);
		throw new PolarError(`Polar answered ${response.status} to ${method} ${path}: ${detail}`, response.status);
	}
	return response.json();
}

function getKey(planId, interval, addon) {
	return addon ? `${addon}:${interval}` : `${planId}:${interval}`;
}

function getExpectedAmount(planId, interval, addon) {
	return (addon === DEDICATED_IP_ADDON ? DEDICATED_IP_PRICE : getPrice(getPlan(planId), interval)) * 100;
}

// Product ids by plan and interval (and add-on), for the products that are ours and priced right. The newest product
// wins a key.
async function readProducts() {
	if (products && Date.now() < products.until) return products.ids;
	const found = new Map();
	for (let page = 1; page <= MAX_PRODUCT_PAGES; page++) {
		const query = { is_archived: "false", is_recurring: "true", limit: String(PRODUCTS_PER_PAGE), page: String(page), sorting: "-created_at" };
		const list = await polarRequest("/v1/products/", { query, timeout: LIST_TIMEOUT_MS });
		for (const product of list.items ?? []) {
			const key = getProductKey(product);
			if (!key || found.has(key)) continue;
			const { flockstack_plan: planId, interval, [ADDON_METADATA]: addon } = product.metadata;
			found.set(key, isPricedRight(product, getExpectedAmount(planId, interval, addon), interval) ? product.id : null);
		}
		if (page >= (list.pagination?.max_page ?? 1)) break;
	}
	const ids = new Map([...found].filter(([, id]) => id));
	products = { ids, until: Date.now() + PLANS_ON_SALE_MS };
	return ids;
}

// The product for a plan, or for the dedicated IP add-on (planId is ignored for it), refused when Polar and lib/plans.js
// disagree on the amount.
export async function findProductId(planId, interval, addon) {
	const id = (await readProducts()).get(getKey(planId, interval, addon));
	if (!id) {
		const named = addon ? `${ADDON_METADATA}=${addon}` : `flockstack_plan=${planId}`;
		throw new Error(`No active Polar product has ${named} and interval=${interval} at ${getExpectedAmount(planId, interval, addon)} USD cents`);
	}
	return id;
}

// Whether the dedicated IP add-on can be bought: its monthly product is there at lib/plans.js's amount.
export async function isDedicatedIpOnSale() {
	if (!isPolarConfigured()) return false;
	try {
		return (await readProducts()).has(getKey(null, "month", DEDICATED_IP_ADDON));
	} catch (error) {
		console.error("[billing] Couldn't read the add-on's products from Polar:", error.message);
		return false;
	}
}

// The plans Polar has both products of, at lib/plans.js's amounts, in plan order: a plan whose products aren't there
// yet stays off the pricing pages, the paywall and billing, and can't be picked. Static pages read it when they're built,
// the rest every 10 minutes at most. When Polar can't be read, every plan: Checkout still checks the product.
export async function findPlansOnSale() {
	if (!isPolarConfigured()) return PLANS;
	if (Date.now() < failedUntil) return PLANS;
	try {
		const ids = await readProducts();
		return PLANS.filter(({ id }) => INTERVALS.every((interval) => ids.has(getKey(id, interval))));
	} catch (error) {
		console.error("[billing] Couldn't read the plans' products from Polar, so every plan shows:", error.message);
		failedUntil = Date.now() + PLANS_ON_SALE_RETRY_MS;
		return PLANS;
	}
}

// The account id travels as the external customer id and in the metadata, which Polar copies onto the subscription,
// so every webhook finds its account.
export async function createCheckoutSession({ account, user, planId, interval, attribution = {} }) {
	const productId = await findProductId(planId, interval);
	const accountId = String(account._id);
	const appUrl = getAppUrl();
	const checkout = await polarRequest("/v1/checkouts/", {
		method: "POST",
		body: {
			products: [productId],
			external_customer_id: accountId,
			...(!account.polarCustomerId && { customer_email: user.email }),
			metadata: { ...attribution, accountId, plan: planId, interval },
			success_url: `${appUrl}/billing/return?checkout_id={CHECKOUT_ID}`,
			return_url: `${appUrl}/billing?interval=${interval}`,
		},
	});
	if (!checkout.url) throw new Error("Polar's checkout has no URL");
	return checkout.url;
}

// The add-on is a subscription of its own, on the same Polar customer as the plan (the organization has to allow several
// subscriptions per customer: README, billing). Its metadata names it, so the webhook tells it from the plan's.
export async function createDedicatedIpCheckout({ account, user, planId, attribution = {} }) {
	const productId = await findProductId(null, "month", DEDICATED_IP_ADDON);
	const accountId = String(account._id);
	const appUrl = getAppUrl();
	const checkout = await polarRequest("/v1/checkouts/", {
		method: "POST",
		body: {
			products: [productId],
			external_customer_id: accountId,
			...(!account.polarCustomerId && { customer_email: user.email }),
			metadata: { ...attribution, accountId, addon: DEDICATED_IP_ADDON, plan: planId, interval: "month" },
			success_url: `${appUrl}/billing/return?addon=${DEDICATED_IP_ADDON}&checkout_id={CHECKOUT_ID}`,
			return_url: `${appUrl}/billing`,
		},
	});
	if (!checkout.url) throw new Error("Polar's checkout has no URL");
	return checkout.url;
}

// The customer portal: payment method, invoices, plan changes and cancellation. A plan change is made there, so a
// plan and interval aren't used.
export async function createPortalSession({ account }) {
	const session = await polarRequest("/v1/customer-sessions/", {
		method: "POST",
		body: {
			...(account.polarCustomerId ? { customer_id: account.polarCustomerId } : { external_customer_id: String(account._id) }),
			return_url: `${getAppUrl()}/billing`,
		},
	});
	if (!session.customer_portal_url) throw new Error("Polar's portal session has no URL");
	return session.customer_portal_url;
}

export function getSubscription(id) {
	return polarRequest(`/v1/subscriptions/${encodeURIComponent(id)}`);
}

// The account's subscriptions, newest first.
export async function listSubscriptions(accountId) {
	const list = await polarRequest("/v1/subscriptions/", {
		query: { external_customer_id: String(accountId), limit: "10", sorting: "-started_at" },
	});
	return list.items ?? [];
}

// Ends a subscription once its period is over: nothing more is charged, and it stays active until then.
export function cancelSubscriptionAtPeriodEnd(id) {
	return polarRequest(`/v1/subscriptions/${encodeURIComponent(id)}`, { method: "PATCH", body: { cancel_at_period_end: true } });
}

// Moves a subscription to another product; Polar prorates the difference.
export function changeSubscriptionProduct(id, productId) {
	return polarRequest(`/v1/subscriptions/${encodeURIComponent(id)}`, { method: "PATCH", body: { product_id: productId } });
}

// Usage events. Polar skips an event whose external_id it already has and counts it in `duplicates`, which is what makes
// a report sent again after a failure safe (lib/extra-emails.js).
export function ingestEvents(events) {
	return polarRequest("/v1/events/ingest", { method: "POST", body: { events } });
}
