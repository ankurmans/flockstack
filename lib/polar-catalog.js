import { DEDICATED_IP_PLAN_IDS, EXTRA_EMAILS, INTERVALS, PLANS, getDedicatedIpPrice, getPrice } from "./plans.js";
import { formatNumber } from "./format.js";

// What FlockStack sells on Polar, from lib/plans.js: read by the app (lib/polar.js) and written by
// scripts/polar-setup.mjs, so both agree on the names, the metadata and the amounts. Relative imports only: the script
// runs in plain Node.

// Polar's API is versioned by date, and a request without a version gets whatever is current that quarter. Requests,
// and the webhook endpoint's own api_version (README), stay on this one until the code is checked against the next.
export const POLAR_API_VERSION = "2026-10";

export const PLAN_METADATA = "flockstack_plan";
export const INTERVAL_METADATA = "interval";
export const ADDON_METADATA = "flockstack_addon";
export const DEDICATED_IP_ADDON = "dedicated_ip";

// Extra emails are reported as these events (lib/extra-emails.js), each with the number of emails in `count`; the meter
// sums them. Its name is what customers read on their invoices, and how a subscription's metered price is recognized.
export const EXTRA_EMAILS_EVENT = "flockstack_extra_emails";
export const EXTRA_EMAILS_METER_NAME = "Extra emails";
export const METER_METADATA = { flockstack_meter: "extra_emails" };

export function getMeterBody() {
	return {
		name: EXTRA_EMAILS_METER_NAME,
		filter: { conjunction: "and", clauses: [{ property: "name", operator: "eq", value: EXTRA_EMAILS_EVENT }] },
		aggregation: { func: "sum", property: "count" },
		// Shown per 1,000 emails; billing still counts single emails.
		unit: "custom",
		custom_label: "emails",
		custom_multiplier: 1000,
		metadata: METER_METADATA,
	};
}

// The metered price on every plan's product: per email, in cents. Capped at the most an owner can allow over the time
// Polar settles it (EXTRA_EMAILS.maxLimitMultiple times the plan's emails a month), so a bug can never bill past what
// the app lets them send. months: 12 for a yearly product that settles once a year.
export function getExtraEmailsPrice(plan, meterId, months = 1) {
	const capEmails = plan.emailsPerMonth * EXTRA_EMAILS.maxLimitMultiple * months;
	return {
		amount_type: "metered_unit",
		meter_id: meterId,
		unit_amount: EXTRA_EMAILS.unitAmountCents,
		cap_amount: Math.round(capEmails * Number(EXTRA_EMAILS.unitAmountCents)),
		price_currency: "usd",
	};
}

function getIntervalLabel(interval) {
	return interval === "year" ? "yearly" : "monthly";
}

// Every product FlockStack sells: 5 plans and 3 dedicated IP add-ons, each monthly and yearly. key: how lib/polar.js
// files it. amount: the fixed price in cents. getBody: the body that creates it, given the meter's id.
export function getCatalog() {
	const plans = PLANS.flatMap((plan) =>
		INTERVALS.map((interval) => ({
			key: `${plan.id}:${interval}`,
			kind: "plan",
			plan,
			interval,
			amount: getPrice(plan, interval) * 100,
			getBody: (meterId) => ({
				name: `FlockStack ${plan.name} (${getIntervalLabel(interval)})`,
				description: `${formatNumber(plan.emailsPerMonth)} emails a month and ${formatNumber(plan.subscribers)} subscribers, with every feature. Extra emails past the plan's are $${EXTRA_EMAILS.pricePerThousand} per 1,000.`,
				recurring_interval: interval,
				recurring_interval_count: 1,
				// Yearly plans still settle extra emails every month, like the app counts them.
				...(interval === "year" && { meter_interval: "month", meter_interval_count: 1 }),
				prices: [{ amount_type: "fixed", price_amount: getPrice(plan, interval) * 100, price_currency: "usd" }, getExtraEmailsPrice(plan, meterId)],
				metadata: { [PLAN_METADATA]: plan.id, [INTERVAL_METADATA]: interval },
			}),
		}))
	);
	const addons = PLANS.filter(({ id }) => DEDICATED_IP_PLAN_IDS.includes(id)).flatMap((plan) =>
		INTERVALS.map((interval) => ({
			key: `${DEDICATED_IP_ADDON}:${plan.id}:${interval}`,
			kind: "addon",
			plan,
			interval,
			amount: getDedicatedIpPrice(plan.id, interval) * 100,
			getBody: () => ({
				name: `FlockStack dedicated IP for ${plan.name} (${getIntervalLabel(interval)})`,
				description: "Your own sending IP, warmed up automatically by AWS. Best for steady volume above 250,000 emails a month.",
				recurring_interval: interval,
				recurring_interval_count: 1,
				prices: [{ amount_type: "fixed", price_amount: getDedicatedIpPrice(plan.id, interval) * 100, price_currency: "usd" }],
				metadata: { [PLAN_METADATA]: plan.id, [INTERVAL_METADATA]: interval, [ADDON_METADATA]: DEDICATED_IP_ADDON },
			}),
		}))
	);
	return [...plans, ...addons];
}

// The catalog key a product's metadata names, or null for a product that isn't FlockStack's.
export function getProductKey(product) {
	const planId = product?.metadata?.[PLAN_METADATA];
	const interval = product?.metadata?.[INTERVAL_METADATA];
	const addon = product?.metadata?.[ADDON_METADATA];
	if (!PLANS.some(({ id }) => id === planId) || !INTERVALS.includes(interval)) return null;
	if (!addon) return `${planId}:${interval}`;
	return addon === DEDICATED_IP_ADDON && DEDICATED_IP_PLAN_IDS.includes(planId) ? `${addon}:${planId}:${interval}` : null;
}

function getActivePrices(product) {
	return (product.prices ?? []).filter((price) => !price.is_archived);
}

// One fixed price at our amount, every 1 interval, and any metered prices next to it: those bill by usage at the end of
// a period.
export function isPricedRight(product, amount, interval) {
	if (product.is_archived || product.visibility === "draft") return false;
	if (product.recurring_interval !== interval || (product.recurring_interval_count ?? 1) !== 1) return false;
	const prices = getActivePrices(product);
	const fixed = prices.filter((price) => price.amount_type === "fixed");
	if (fixed.length !== 1 || prices.some((price) => price.amount_type !== "fixed" && !String(price.amount_type).startsWith("metered"))) return false;
	return fixed[0].price_currency === "usd" && fixed[0].price_amount === amount;
}

// The extra emails metered price, among a subscription's or a product's prices.
export function hasExtraEmailsPrice(prices) {
	return (prices ?? []).some(
		(price) =>
			!price.is_archived &&
			price.amount_type === "metered_unit" &&
			price.meter?.name === EXTRA_EMAILS_METER_NAME &&
			Number(price.unit_amount) === Number(EXTRA_EMAILS.unitAmountCents)
	);
}
