import { getCustomPlan } from "./custom-tier.js";
import { formatCompact, formatNumber, formatUsd, formatUsdCents } from "./format.js";
import { EXTRA_EMAILS, FREE_PLAN, INTERVALS, PLANS, YEARLY_MONTHS, getCheckoutPath, getPrice, getPricePerThousand } from "./plans.js";

// The Free plan as the slider's first stop, before the plans on sale: no price, no checkout. bullets: what it has, in
// words, since "every plan includes" doesn't hold for it (its emails stop at the cap, and it carries a link).
export function getFreePlan() {
	const price = { price: formatUsd(0), monthly: formatUsd(0), perThousand: formatUsdCents(0), href: null };
	return {
		id: FREE_PLAN.id,
		name: FREE_PLAN.name,
		emails: formatNumber(FREE_PLAN.emailsPerMonth),
		emailsShort: formatCompact(FREE_PLAN.emailsPerMonth),
		subscribers: formatNumber(FREE_PLAN.subscribers),
		bar: Math.cbrt(FREE_PLAN.emailsPerMonth / PLANS.at(-1).emailsPerMonth),
		prices: Object.fromEntries(INTERVALS.map((interval) => [interval, price])),
		bullets: [
			`${formatNumber(FREE_PLAN.subscribers)} subscribers`,
			`${formatNumber(FREE_PLAN.emailsPerMonth)} emails a month`,
			"Your own domain",
			"Campaigns and scheduling",
			"Signup forms, polls and surveys",
			`${FREE_PLAN.automations} automations`,
			"API and MCP",
			"A small “Sent with FlockStack” link, which paid plans remove",
		],
	};
}

// What SliderPricing shows, on the pricing pages, the billing page and the paywall: the Free plan, then the plans ready to
// display, with a price for each billing period, starting on the given plan. plans: the ones on sale. custom: the Custom
// plan after them (lib/custom-tier.js), which has no price. initialIndex counts Free as the first step.
export function getPricing(initialPlanId = FREE_PLAN.id, plans = PLANS) {
	const largest = plans.at(-1).emailsPerMonth;
	const stops = plans.map((plan) => ({
		id: plan.id,
		name: plan.name,
		emails: formatNumber(plan.emailsPerMonth),
		emailsShort: formatCompact(plan.emailsPerMonth),
		subscribers: formatNumber(plan.subscribers),
		// A cube root keeps the smaller plans' bars tall enough to read, and apart, next to one 100 times bigger.
		bar: Math.cbrt(plan.emailsPerMonth / largest),
		prices: Object.fromEntries(
			INTERVALS.map((interval) => [
				interval,
				{
					price: formatUsd(getPrice(plan, interval)),
					monthly: formatUsdCents(getPrice(plan, interval) / 12),
					perThousand: formatUsdCents(getPricePerThousand(plan, interval)),
					href: getCheckoutPath(plan.id, interval),
				},
			])
		),
	}));
	return {
		free: getFreePlan(),
		plans: stops,
		custom: getCustomPlan(),
		freeMonths: 12 - YEARLY_MONTHS,
		extraPerThousand: formatUsdCents(EXTRA_EMAILS.pricePerThousand),
		initialIndex: initialPlanId === FREE_PLAN.id ? 0 : Math.max(0, plans.findIndex(({ id }) => id === initialPlanId) + 1),
	};
}
