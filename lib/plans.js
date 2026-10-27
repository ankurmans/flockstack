import { isCloud } from "./config.js";

// Prices in USD. Yearly costs 10 months. Stripe prices are found by lookup key
// (flockstack_<plan>_<monthly|yearly>), Polar products by metadata (flockstack_plan, interval), and checkout refuses a
// price whose amount differs from this file. A plan is only offered once the provider has both of its prices
// (findPlansOnSale in lib/stripe.js and lib/polar.js).
export const YEARLY_MONTHS = 10;
export const INTERVALS = ["month", "year"];

const GB = 1024 ** 3;

// importPosts: new issues one post import may add (lib/post-import.js). importImageBytes: what the pictures post imports
// copy into the images bucket may weigh, every import of the account together. aiRequestsPerDay: the shared AI allowance's
// requests (lib/ai-usage.js), counted per account per UTC day; Workers AI bills the operator for model usage.
export const PLANS = [
	{ id: "starter", newsletters: 3, name: "Starter", monthlyPrice: 9, emailsPerMonth: 25_000, subscribers: 5_000, importPosts: 500, importImageBytes: 1 * GB, webhookEndpoints: 3, aiRequestsPerDay: 20 },
	{ id: "growth", newsletters: 5, name: "Growth", monthlyPrice: 29, emailsPerMonth: 125_000, subscribers: 25_000, importPosts: 1_500, importImageBytes: 3 * GB, webhookEndpoints: 5, aiRequestsPerDay: 60 },
	{ id: "pro", newsletters: 10, name: "Pro", monthlyPrice: 59, emailsPerMonth: 250_000, subscribers: 50_000, importPosts: 3_000, importImageBytes: 6 * GB, webhookEndpoints: 10, aiRequestsPerDay: 150 },
	{ id: "scale", newsletters: 25, name: "Scale", monthlyPrice: 109, emailsPerMonth: 500_000, subscribers: 100_000, importPosts: 5_000, importImageBytes: 10 * GB, webhookEndpoints: 20, aiRequestsPerDay: 300 },
	{ id: "max", newsletters: 50, name: "Max", monthlyPrice: 299, emailsPerMonth: 2_000_000, subscribers: 400_000, importPosts: 10_000, importImageBytes: 25 * GB, webhookEndpoints: 50, aiRequestsPerDay: 600 },
];

export const PLAN_IDS = PLANS.map(({ id }) => id);

const MB = 1024 ** 2;

// The Free plan: what an account has without a paid subscription, a lapsed one included. It is not a Polar product and not
// in PLANS, so nothing sells it, checks its price or lists it as a plan on sale. No extra emails past emails, no dedicated
// IP, and a "Sent with FlockStack" link on its emails and website (showsSentWithLink in lib/free-plan.js). newsletters,
// automations: how many it may have, besides the welcome email; paid plans have their own newsletter limit
// and as many automations as they like. An admin raises the emails and subscribers of one account with limitOverrides.
export const FREE_PLAN = {
	id: "free",
	name: "Free",
	monthlyPrice: 0,
	emailsPerMonth: 10_000,
	subscribers: 2_500,
	importPosts: 100,
	importImageBytes: 200 * MB,
	webhookEndpoints: 1,
	newsletters: 1,
	automations: 2,
	aiRequestsPerDay: 5,
};

// Abuse guards for Free, because a free plan draws spam. firstCampaigns: until the account has sent this many campaigns
// that went well (bounces and complaints under the Free watch level, FREE_WATCH in lib/config.js, and at least minOpenRate
// of the emails opened, settleHours after each went out), every campaign goes to recipients people at most.
// signupsPerIpPerDay, signupsPerDay: new accounts a day from one network, and from everywhere in a region.
export const FREE_GUARDS = {
	firstCampaigns: { count: 3, recipients: 500, minOpenRate: 0.01, settleHours: 24 },
	signupsPerIpPerDay: 3,
	signupsPerDay: 1_000,
};

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

// A dedicated IP is an add-on of its own on Pro and above, paid before it turns on, and it's sold AT COST: one price on every
// one of those plans, monthly only (an at-cost item has no yearly discount, and a yearly plan holds it next to it as a
// second, monthly subscription). AWS leases a standard dedicated IP for $24.95 a month (read on 2026-10-20 at
// aws.amazon.com/ses/pricing; no minimum, and we warm it up ourselves) and Polar keeps 4% + $0.40 of every charge, so the
// price that breaks even is (24.95 + 0.40) / 0.96 = $26.41. $27 nets 27 x 0.96 - 0.40 = $25.52 after Polar: $0.57 over the
// lease, rounding and no markup. tests/dedicated-ip.test.mjs fails when a change here or at AWS or Polar puts it under water.
export const DEDICATED_IP_PRICE = 27;
export const DEDICATED_IP_AWS_MONTHLY_COST = 24.95;
export const POLAR_FEE = { rate: 0.04, fixed: 0.4 };
export const DEDICATED_IP_PLAN_IDS = ["pro", "scale", "max"];

// What is left of a charge after Polar's fee, in USD to the cent.
export function getNetAfterPolar(amount) {
	return Math.round((amount * (1 - POLAR_FEE.rate) - POLAR_FEE.fixed) * 100) / 100;
}

// USD a month, the same on every plan from Pro up; null below Pro.
export function getDedicatedIpPrice(planId) {
	return DEDICATED_IP_PLAN_IDS.includes(planId) ? DEDICATED_IP_PRICE : null;
}

// What the owner may say about it, in one place: the card, the docs, Polar's product, the support corpus.
export const DEDICATED_IP_AT_COST = `At cost. AWS charges us $${DEDICATED_IP_AWS_MONTHLY_COST} a month for your own sending IP and card fees come to about $${(Math.round((DEDICATED_IP_PRICE * POLAR_FEE.rate + POLAR_FEE.fixed) * 2) / 2).toFixed(2)}; you pay $${DEDICATED_IP_PRICE} a month, with no markup on top. We make our money from your plan, not your IP.`;
export const DEDICATED_IP_DETAILS =
	"One IP of your own, warmed up over about 4 to 6 weeks (your email goes through shared IPs until then), best for steady volume above about 100,000 emails a month.";

// Stripe keeps a subscription past_due while it retries the card; the account keeps working meanwhile.
const PAID_STATUSES = new Set(["active", "trialing", "past_due"]);

export function isPaidStatus(status) {
	return PAID_STATUSES.has(status);
}

// A paid plan an admin gave for free (account.comp, not the Free plan) runs from grantedAt until `until`, or for good without one.
export function hasActiveFreePlan(account, now = new Date()) {
	const comp = account?.comp;
	return Boolean(getPlan(comp?.plan) && comp.grantedAt) && (!comp.until || new Date(comp.until) > now);
}

// A plan Stripe or Polar bills is in charge while it lasts; an admin's plan still running takes over when it ends.
export function isOnFreePlan(account, now = new Date()) {
	return !isPaidStatus(account?.subscriptionStatus) && hasActiveFreePlan(account, now);
}

// The plan the account is on: an admin's free plan (account.comp) while it runs, the plan it pays for, else Free. A paid plan
// that ended or lapsed falls back to Free, with all its data kept.
export function getAccountPlan(account) {
	if (isOnFreePlan(account)) return getPlan(account.comp.plan);
	if (isPaidStatus(account?.subscriptionStatus)) return getPlan(account.plan) ?? FREE_PLAN;
	return FREE_PLAN;
}

// On FlockStack Cloud only: a self-hosted server has no plans.
export function isOnFreeTier(account) {
	return isCloud() && getAccountPlan(account).id === FREE_PLAN.id;
}

// An admin's numbers win over the plan's. A self-hosted server has no plans, so nothing is limited: null.
export function getAccountLimits(account) {
	if (!isCloud()) return null;
	const plan = getAccountPlan(account);
	return {
		emails: account?.limitOverrides?.emailsPerMonth ?? plan.emailsPerMonth,
		subscribers: account?.limitOverrides?.subscribers ?? plan.subscribers,
	};
}

// Outgoing webhooks are on every plan; each Zapier or Make trigger is an endpoint of its own. A self-hosted server has no
// limit: null.
export function getWebhookEndpointLimit(account) {
	if (!isCloud()) return null;
	return getAccountPlan(account).webhookEndpoints;
}

// The writing tools' requests an account may make a day: its plan's. A self-hosted server has no
// plans, so only AI_DAILY_LIMIT limits it; null is no limit.
export function getAiDailyLimit(account, env = process.env) {
	if (!isCloud()) {
		const limit = Number.parseInt(env.AI_DAILY_LIMIT, 10);
		return Number.isInteger(limit) && limit >= 0 ? limit : null;
	}
	return getAccountPlan(account)?.aiRequestsPerDay ?? 0;
}

// A post import's caps: null on a self-hosted server, which has no plans.
export function getImportLimits(account) {
	if (!isCloud()) return null;
	const plan = getAccountPlan(account);
	return { posts: plan.importPosts, imageBytes: plan.importImageBytes };
}

// Only a paid Polar plan whose subscription carries the extra emails price (account.extraEmails.billable, set by the
// webhook) can go past its emails: Free, an admin's free plan, Stripe and a self-hosted server have nobody to bill, so
// they stop there.
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

// Audio versions of issues cost FlockStack's owner by the character at ElevenLabs. The API price read on 2026-10-20 at
// elevenlabs.io/pricing/api is $0.08 per 1,000 characters for Multilingual v2, v3 and v4 and $0.04 for Flash and Turbo; the
// quotas below are sized on the dearer rate so that any model the owner picks stays inside the budget. A plan's whole quota
// costs at most 10% of its monthly price: price x 0.10 / 0.00008 = price x 1,250 characters, rounded down.
//   Starter  $9    11,250 -> 11,000   $0.88 (9.8%)
//   Growth   $29   36,250 -> 36,000   $2.88 (9.9%)
//   Pro      $59   73,750 -> 73,000   $5.84 (9.9%)
//   Scale    $109 136,250 -> 136,000  $10.88 (10.0%)
//   Max      $299 373,750 -> 373,000  $29.84 (10.0%)
// Free has none (FREE_PLAN is the plan of an account without a paid one), and so has an account with no plan. A yearly plan gets the same each month (its monthly price x 10 / 12 makes it about 12%).
export const AUDIO_COST = { pricePerThousandCharacters: 0.08, shareOfPlanPrice: 0.1 };
export const AUDIO_CHARACTERS_PER_MONTH = { free: 0, starter: 11_000, growth: 36_000, pro: 73_000, scale: 136_000, max: 373_000 };

// The characters of audio an account may have read in a month: an admin's number, else the plan's, none on Free. Apart from
// the AI requests a day (aiRequestsPerDay): a different counter (lib/audio-quota.js).
// A self-hosted server has no plans and pays ElevenLabs itself: null, no limit.
export function getAudioLimit(account) {
	if (!isCloud()) return null;
	return account?.limitOverrides?.audioCharactersPerMonth ?? AUDIO_CHARACTERS_PER_MONTH[getAccountPlan(account)?.id] ?? 0;
}
