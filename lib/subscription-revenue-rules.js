import { createHash } from "node:crypto";
import { LEGACY_TIER_ID } from "./tier-rules.js";

export const REVENUE_SCAN_LIMITS = { subscriptions: 5000, changes: 20000, invoices: 10000 };
const MRR_STATUSES = new Set(["active", "past_due"]);
const STATUSES = new Set(["active", "past_due", "trialing", "incomplete", "incomplete_expired", "unpaid", "canceled", "paused"]);
export const currencyCode = (value) => typeof value === "string" && /^[a-z]{3}$/.test(value) ? value : null;
export const minorAmount = (value) => Number.isSafeInteger(value) && value >= 0;

function discountsOf(object) {
	if (Array.isArray(object.discounts) && object.discounts.length) return object.discounts;
	if (object.discount) return [object.discount];
	return object.discounts == null || Array.isArray(object.discounts) ? [] : null;
}

function couponOf(discount, now) {
	if (!discount || typeof discount !== "object") return { problem: "discount_details_missing" };
	if ((Number.isFinite(discount.start) && discount.start * 1000 > now) || (Number.isFinite(discount.end) && discount.end * 1000 <= now)) return { ignored: true };
	const coupon = discount.coupon ?? discount.source?.coupon;
	if (!coupon || typeof coupon !== "object") return { problem: "discount_details_missing" };
	if (coupon.duration === "once") return { ignored: true };
	if (!["forever", "repeating"].includes(coupon.duration)) return { problem: "discount_duration_unknown" };
	if (coupon.duration === "repeating" && !Number.isFinite(discount.end)) return { problem: "discount_duration_unknown" };
	return { coupon };
}

function applyDiscounts(items, discounts, currency, now) {
	if (!discounts || discounts.length > 20) return "discount_details_missing";
	for (const discount of discounts) {
		const { coupon, problem, ignored } = couponOf(discount, now);
		if (ignored) continue;
		if (problem) return problem;
		if (!Object.hasOwn(coupon, "applies_to")) return "discount_product_unknown";
		const products = coupon.applies_to?.products;
		if (products && Array.isArray(products) && products.length === 0) return "discount_product_unknown";
		if (products && (!Array.isArray(products) || items.some((item) => !item.product))) return "discount_product_unknown";
		const eligible = products ? items.filter((item) => products.includes(item.product)) : items;
		if (!eligible.length) continue;
		if (typeof coupon.percent_off === "number" && Number.isFinite(coupon.percent_off) && coupon.percent_off >= 0 && coupon.percent_off <= 100 && !coupon.amount_off) {
			for (const item of eligible) item.net *= 1 - coupon.percent_off / 100;
		} else {
			const amount = coupon.currency === currency ? coupon.amount_off : coupon.currency_options?.[currency]?.amount_off;
			if (!minorAmount(amount) || eligible.length !== 1 || coupon.percent_off) return "fixed_discount_allocation_unknown";
			eligible[0].net = Math.max(0, eligible[0].net - amount);
		}
	}
	return null;
}

export function normalizeSubscriptionFinancial(subscription, { tierIds = [], now = Date.now() } = {}) {
	const all = subscription.items?.data;
	const rawTier = subscription.metadata?.tierId ?? (tierIds.includes(LEGACY_TIER_ID) ? LEGACY_TIER_ID : null);
	const tierId = tierIds.includes(rawTier) ? rawTier : null;
	const firstPrice = all?.[0]?.price ?? all?.[0]?.plan;
	const state = {
		status: STATUSES.has(subscription.status) ? subscription.status : "unknown",
		currency: currencyCode(subscription.currency) ?? currencyCode(firstPrice?.currency),
		tierId, tierRank: tierId ? tierIds.indexOf(tierId) : null,
		tierOrderHash: createHash("sha256").update(JSON.stringify(tierIds)).digest("hex"),
		cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
		collectionPaused: Boolean(subscription.pause_collection),
		recurring: MRR_STATUSES.has(subscription.status) && !subscription.pause_collection,
		grossMonthlyMinor: null, monthlyRecurringMinor: null, reason: null,
	};
	if (!STATUSES.has(state.status)) return { ...state, reason: "subscription_status_unknown" };
	if (!state.recurring) return { ...state, grossMonthlyMinor: 0, monthlyRecurringMinor: 0 };
	if (!Array.isArray(all) || !all.length || all.length > 20 || subscription.items.has_more) return { ...state, reason: "price_details_missing" };
	const items = [];
	let netProblem = null;
	for (const item of all) {
		if (item.current_trial) continue;
		const price = typeof item.price === "object" && item.price ? item.price : item.plan;
		const recurring = price?.recurring ?? item.plan;
		if (price?.type === "one_time" || recurring?.usage_type === "metered") continue;
		if (!price || !recurring || price.billing_scheme === "tiered" || price.transform_quantity || price.transform_usage) return { ...state, reason: "non_fixed_price" };
		const interval = recurring.interval;
		const count = recurring.interval_count ?? 1;
		const months = interval === "month" ? count : interval === "year" ? count * 12 : null;
		const amount = price.unit_amount ?? price.amount ?? (/^\d+(?:\.0+)?$/.test(price.unit_amount_decimal ?? "") ? Number(price.unit_amount_decimal) : null);
		if (!months || !Number.isSafeInteger(months) || !Number.isSafeInteger(count) || count <= 0 || !minorAmount(amount) || !Number.isSafeInteger(item.quantity) || item.quantity < 0 || !minorAmount(amount * item.quantity)) return { ...state, reason: "price_details_missing" };
		const currency = currencyCode(price.currency);
		if (!currency || (state.currency && state.currency !== currency)) return { ...state, reason: "currency_unknown" };
		state.currency = currency;
		const product = typeof price.product === "string" ? price.product : price.product?.id ?? null;
		const normalized = { product, months, base: amount * item.quantity, net: amount * item.quantity };
		const rates = [subscription.default_tax_rates, item.tax_rates].flatMap((value) => value == null ? [] : Array.isArray(value) ? value : [value]);
		if (price.tax_behavior === "inclusive" || rates.some((rate) => !rate || typeof rate !== "object" || rate.inclusive) || (subscription.automatic_tax?.enabled && price.tax_behavior !== "exclusive")) netProblem = "tax_adjustment_unknown";
		netProblem ||= applyDiscounts([normalized], discountsOf(item), currency, now);
		items.push(normalized);
	}
	state.grossMonthlyMinor = items.reduce((sum, item) => sum + item.base / item.months, 0);
	if (!Number.isFinite(state.grossMonthlyMinor) || state.grossMonthlyMinor > Number.MAX_SAFE_INTEGER) return { ...state, grossMonthlyMinor: null, reason: "price_details_missing" };
	if (state.grossMonthlyMinor === 0) return { ...state, recurring: false, monthlyRecurringMinor: 0, reason: null };
	netProblem ||= applyDiscounts(items, discountsOf(subscription), state.currency, now);
	return { ...state, monthlyRecurringMinor: netProblem ? null : items.reduce((sum, item) => sum + item.net / item.months, 0), reason: netProblem };
}

export function classifySubscriptionChange(before, after) {
	if (!before) return "first_seen";
	if (before.recurring && ["canceled", "unpaid"].includes(after.status)) return "churn";
	if (before.currency !== after.currency) return "currency_changed";
	if (before.recurring && (after.collectionPaused || after.status === "paused")) return "paused";
	if (!before.recurring && after.recurring) return ["canceled", "unpaid"].includes(before.status) ? "reactivated" : "activated";
	if (before.tierId !== after.tierId) {
		if (before.tierId && after.tierId && before.tierOrderHash === after.tierOrderHash) return after.tierRank > before.tierRank ? "upgraded" : "downgraded";
		return "plan_changed";
	}
	if (before.monthlyRecurringMinor !== null && after.monthlyRecurringMinor !== null) {
		if (after.monthlyRecurringMinor > before.monthlyRecurringMinor) return "expanded";
		if (after.monthlyRecurringMinor < before.monthlyRecurringMinor) return "contracted";
	}
	return "updated";
}
