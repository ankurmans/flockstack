import { isCloud } from "./config.js";

// Prices in USD. Yearly costs 10 months. Stripe prices are found by lookup key
// (flockstack_<plan>_<monthly|yearly>), Polar products by metadata (flockstack_plan, interval), and checkout refuses a
// price whose amount differs from this file. A plan is only offered once the provider has both of its prices
// (findPlansOnSale in lib/stripe.js and lib/polar.js).
export const YEARLY_MONTHS = 10;
export const INTERVALS = ["month", "year"];

const GB = 1024 ** 3;

// importPosts: new issues one post import may add (lib/post-import.js). importImageBytes: what the pictures post imports
// copy into the images bucket may weigh, every import of the account together.
export const PLANS = [
	{ id: "starter", name: "Starter", monthlyPrice: 9, emailsPerMonth: 25_000, subscribers: 5_000, importPosts: 500, importImageBytes: 1 * GB, webhookEndpoints: 3 },
	{ id: "growth", name: "Growth", monthlyPrice: 29, emailsPerMonth: 125_000, subscribers: 25_000, importPosts: 1_500, importImageBytes: 3 * GB, webhookEndpoints: 5 },
	{ id: "pro", name: "Pro", monthlyPrice: 59, emailsPerMonth: 250_000, subscribers: 50_000, importPosts: 3_000, importImageBytes: 6 * GB, webhookEndpoints: 10 },
	{ id: "scale", name: "Scale", monthlyPrice: 109, emailsPerMonth: 500_000, subscribers: 100_000, importPosts: 5_000, importImageBytes: 10 * GB, webhookEndpoints: 20 },
	{ id: "max", name: "Max", monthlyPrice: 299, emailsPerMonth: 2_000_000, subscribers: 400_000, importPosts: 10_000, importImageBytes: 25 * GB, webhookEndpoints: 50 },
];

export const PLAN_IDS = PLANS.map(({ id }) => id);

const LOOKUP_KEY_PATTERN = /^flockstack_([a-z]+)_(monthly|yearly)$/;

export function getPlan(id) {
	return PLANS.find((plan) => plan.id === id) ?? null;
}

export function readInterval(value) {
	return INTERVALS.includes(value) ? value : "month";
}

export function getPrice(plan, interval) {
	return plan.monthlyPrice * (interval === "year" ? YEARLY_MONTHS : 1);
}

// What a month costs per 1,000 emails of the plan's allowance; yearly plans spread their price over 12 months.
export function getPricePerThousand(plan, interval) {
	const monthlyCost = getPrice(plan, interval) / (interval === "year" ? 12 : 1);
	return monthlyCost / (plan.emailsPerMonth / 1000);
}

export function getLookupKey(planId, interval) {
	return `flockstack_${planId}_${interval === "year" ? "yearly" : "monthly"}`;
}

export function parseLookupKey(lookupKey) {
	const match = LOOKUP_KEY_PATTERN.exec(String(lookupKey ?? ""));
	if (!match || !getPlan(match[1])) return null;
	return { plan: match[1], interval: match[2] === "yearly" ? "year" : "month" };
}

// Plan buttons on the public pages link here; signed-out visitors come back to it after signing in.
export const CHECKOUT_PATH = "/billing/checkout";

export function getCheckoutPath(planId, interval) {
	return `${CHECKOUT_PATH}?plan=${planId}&interval=${readInterval(interval)}`;
}

// Extra emails: past a paid plan's emails, an account billed by Polar keeps sending and pays for each extra email by
// usage (Polar's metered price, lib/extra-emails.js), up to a monthly limit its owner sets: the plan's own emails by
// default, so a month costs at most twice the plan's emails unless the owner raises it.
export const EXTRA_EMAILS = {
	pricePerThousand: 0.15,
	// Polar takes a metered price per unit in cents, with up to 12 decimals: $0.15 per 1,000 is 0.015 cents an email.
	unitAmountCents: "0.015",
	maxLimitMultiple: 10,
};

// USD, rounded to the cent.
export function getExtraEmailsCost(count) {
	return Math.round(((count * EXTRA_EMAILS.pricePerThousand) / 1000) * 100) / 100;
}

// A dedicated IP is an add-on of its own on Pro and above, paid before it turns on: USD a month, a year at 10 months.
export const DEDICATED_IP_PRICES = { pro: 35, scale: 69, max: 269 };
export const DEDICATED_IP_PLAN_IDS = Object.keys(DEDICATED_IP_PRICES);

export function getDedicatedIpPrice(planId, interval) {
	const monthly = DEDICATED_IP_PRICES[planId];
	return monthly === undefined ? null : monthly * (interval === "year" ? YEARLY_MONTHS : 1);
}

// Stripe keeps a subscription past_due while it retries the card; the account keeps working meanwhile.
const PAID_STATUSES = new Set(["active", "trialing", "past_due"]);

export function isPaidStatus(status) {
	return PAID_STATUSES.has(status);
}

// A free plan an admin gave (account.comp) runs from grantedAt until `until`, or for good without one.
export function hasActiveFreePlan(account, now = new Date()) {
	const comp = account?.comp;
	return Boolean(getPlan(comp?.plan) && comp.grantedAt) && (!comp.until || new Date(comp.until) > now);
}

// A plan Stripe bills is in charge while it lasts; a free plan still running takes over when it ends.
export function isOnFreePlan(account, now = new Date()) {
	return !isPaidStatus(account?.subscriptionStatus) && hasActiveFreePlan(account, now);
}

// The free plan while the account is on it, else the plan it pays for, or paid for last.
export function getAccountPlan(account) {
	return getPlan(isOnFreePlan(account) ? account.comp.plan : account?.plan);
}

// An admin's numbers win over the plan's. A self-hosted server has no plans, so nothing is limited: null.
export function getAccountLimits(account) {
	if (!isCloud()) return null;
	const plan = getAccountPlan(account);
	return {
		emails: account?.limitOverrides?.emailsPerMonth ?? plan?.emailsPerMonth ?? 0,
		subscribers: account?.limitOverrides?.subscribers ?? plan?.subscribers ?? 0,
	};
}

// Outgoing webhooks are on every plan; each Zapier or Make trigger is an endpoint of its own. A self-hosted server has no
// limit: null.
export function getWebhookEndpointLimit(account) {
	if (!isCloud()) return null;
	return getAccountPlan(account)?.webhookEndpoints ?? 0;
}

// A post import's caps: null on a self-hosted server, which has no plans. An account without a plan gets the smallest's.
export function getImportLimits(account) {
	if (!isCloud()) return null;
	const plan = getAccountPlan(account) ?? PLANS[0];
	return { posts: plan.importPosts, imageBytes: plan.importImageBytes };
}

// Only a paid Polar plan whose subscription carries the extra emails price (account.extraEmails.billable, set by the
// webhook) can go past its emails: a free plan, Stripe and a self-hosted server have nobody to bill, so they stop there.
// past_due stops too: no more on a card that is failing.
export function canSendExtraEmails(account) {
	if (!isCloud() || !process.env.POLAR_ACCESS_TOKEN) return false;
	if (!["active", "trialing"].includes(account?.subscriptionStatus) || isOnFreePlan(account)) return false;
	return Boolean(account.polarSubscriptionId && account.extraEmails?.billable);
}

export function getMaxExtraEmailsLimit(account) {
	return (getAccountLimits(account)?.emails ?? 0) * EXTRA_EMAILS.maxLimitMultiple;
}

// The month's limit on extra emails: 0 when the account can't send any, the owner's number, else the plan's emails.
export function getExtraEmailsLimit(account) {
	if (!canSendExtraEmails(account)) return 0;
	const chosen = account.extraEmails?.limit;
	if (Number.isInteger(chosen) && chosen >= 0) return Math.min(chosen, getMaxExtraEmailsLimit(account));
	return getAccountLimits(account).emails;
}
