import "server-only";
import { stripeRequest } from "@/lib/payments/stripe-api";

const lists = (subscription) => [subscription, ...(subscription.items?.data ?? [])];
function discountList(object) {
	return Array.isArray(object.discounts) && object.discounts.length ? object.discounts : object.discount ? [object.discount] : [];
}

// Financial-only reads: unsupported expansion leaves the amount unknown and never changes the access-critical Stripe read.
export async function readFinancialDiscounts(subscription, { chargeAccount, budget, observedAt, isAllowed }) {
	const paths = [];
	if (discountList(subscription).some((item) => typeof item === "string")) paths.push("discounts");
	if (subscription.items?.data?.some((item) => discountList(item).some((discount) => typeof discount === "string"))) paths.push("items.data.discounts");
	if (paths.length && Date.now() < budget.deadline) {
		let expanded = null;
		const started = new Date();
		try {
			expanded = await stripeRequest(`/v1/subscriptions/${encodeURIComponent(subscription.id)}`, { account: chargeAccount, params: { expand: paths }, timeout: 5000 });
		} catch { /* The original snapshot remains usable for gross prices. */ }
		if (expanded?.id === subscription.id) {
			if (!await isAllowed(expanded)) return { subscription: null, observedAt };
			subscription = expanded; observedAt = started;
		}
	}
	for (const object of lists(subscription)) {
		for (const discount of discountList(object)) {
			if (!discount || typeof discount !== "object") continue;
			const source = discount.coupon ?? discount.source?.coupon;
			if (source && typeof source === "object" && Object.hasOwn(source, "applies_to")) continue;
			const id = typeof source === "string" ? source : source?.id;
			if (typeof id !== "string" || !id || id.length > 128 || Date.now() >= budget.deadline) continue;
			let coupon = budget.coupons.get(id);
			if (!coupon && budget.remaining > 0) {
				budget.remaining--;
				try {
					coupon = await stripeRequest(`/v1/coupons/${encodeURIComponent(id)}`, { account: chargeAccount, params: { expand: ["applies_to", "currency_options"] }, timeout: 5000 });
					if (coupon.id !== id) continue;
					budget.coupons.set(id, coupon);
				} catch { continue; }
			}
			if (!coupon) continue;
			if (discount.coupon !== undefined) discount.coupon = coupon;
			else if (discount.source) discount.source = { ...discount.source, coupon };
		}
	}
	return { subscription, observedAt };
}
