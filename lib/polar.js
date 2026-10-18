import "server-only";
import { getAppUrl } from "@/lib/config";
import { INTERVALS, PLANS, getPlan, getPrice } from "@/lib/plans";

// Products are found by their metadata, flockstack_plan (starter, growth…) and interval (month, year), and refused when
// Polar and lib/plans.js disagree on the amount. scripts/polar-setup.mjs creates them.
const PLAN_METADATA = "flockstack_plan";
const INTERVAL_METADATA = "interval";

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

function getKey(planId, interval) {
	return `${planId}:${interval}`;
}

function getExpectedAmount(planId, interval) {
	return getPrice(getPlan(planId), interval) * 100;
}

function isPlanProduct(product, planId, interval) {
	if (product.is_archived || product.visibility === "draft") return false;
	if (product.recurring_interval !== interval || (product.recurring_interval_count ?? 1) !== 1) return false;
	const prices = (product.prices ?? []).filter((price) => !price.is_archived);
	if (prices.length !== 1) return false;
	const [price] = prices;
	return price.amount_type === "fixed" && price.price_currency === "usd" && price.price_amount === getExpectedAmount(planId, interval);
}

// Product ids by plan and interval, for the products that are ours and priced right. The newest product wins a key.
async function readProducts() {
	if (products && Date.now() < products.until) return products.ids;
	const found = new Map();
	for (let page = 1; page <= MAX_PRODUCT_PAGES; page++) {
		const query = { is_archived: "false", is_recurring: "true", limit: String(PRODUCTS_PER_PAGE), page: String(page), sorting: "-created_at" };
		const list = await polarRequest("/v1/products/", { query, timeout: LIST_TIMEOUT_MS });
		for (const product of list.items ?? []) {
			const planId = product.metadata?.[PLAN_METADATA];
			const interval = product.metadata?.[INTERVAL_METADATA];
			if (!getPlan(planId) || !INTERVALS.includes(interval)) continue;
			const key = getKey(planId, interval);
			if (!found.has(key)) found.set(key, isPlanProduct(product, planId, interval) ? product.id : null);
		}
		if (page >= (list.pagination?.max_page ?? 1)) break;
	}
	const ids = new Map([...found].filter(([, id]) => id));
	products = { ids, until: Date.now() + PLANS_ON_SALE_MS };
	return ids;
}

// The product for a plan, refused when Polar and lib/plans.js disagree on the amount.
export async function findProductId(planId, interval) {
	const id = (await readProducts()).get(getKey(planId, interval));
	if (!id) {
		throw new Error(`No active Polar product has ${PLAN_METADATA}=${planId} and ${INTERVAL_METADATA}=${interval} at ${getExpectedAmount(planId, interval)} USD cents`);
	}
	return id;
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
