import { CURRENCIES } from "./payments/config.js";

export const READER_PAUSE_MONTHS = [1, 3, 6];
export const READER_RETENTION_VERSION = "2026-09-30.endive";
export const CANCELLATION_REASONS = ["cost", "not_reading", "content", "temporary", "other"];
const reference = value => typeof value === "string" ? value : value?.id ?? null;
const subscriptionId = value => /^sub_[A-Za-z0-9_]{1,160}$/.test(value ?? "");

export function readerPersonalSubscriptionId(contact) {
	if (Object.hasOwn(contact ?? {}, "paidPersonal")) return contact.paidPersonal?.kind === "stripe" && subscriptionId(contact.paidPersonal.subscriptionId) ? contact.paidPersonal.subscriptionId : null;
	return contact?.paidSource !== "group" && subscriptionId(contact?.stripeSubscriptionId) ? contact.stripeSubscriptionId : null;
}

export function readReaderSubscription(subscription, contact, newsletter) {
	const metadata = subscription?.metadata;
	const owned = Boolean(subscription?.id === readerPersonalSubscriptionId(contact) && String(contact?.accountId) === String(newsletter?.accountId) && String(contact?.newsletterId) === String(newsletter?._id) && contact.stripeCustomerId && reference(subscription.customer) === contact.stripeCustomerId && metadata?.flockstack === "1" && metadata.kind === "paid_tier" && metadata.accountId === String(newsletter.accountId) && metadata.newsletterId === String(newsletter._id));
	if (!owned) return { owned: false, supported: false, problem: "This reader has no matching personal FlockStack subscription" };
	const items = subscription.items;
	if (!Array.isArray(items?.data) || items.has_more || items.data.length !== 1) return { owned, supported: false, problem: "Reader billing changes support one fixed recurring subscription item" };
	const item = items.data[0], price = item.price, recurring = price?.recurring ?? item.plan;
	const interval = recurring?.interval, count = recurring?.interval_count ?? 1;
	const currency = price?.currency ?? subscription.currency;
	if (item.quantity !== 1 || price?.type !== "recurring" || price.billing_scheme && price.billing_scheme !== "per_unit" || price.transform_quantity || recurring?.usage_type && recurring.usage_type !== "licensed" || !((interval === "month" && [1, 3].includes(count)) || interval === "year" && count === 1) || !Number.isSafeInteger(price.unit_amount) || price.unit_amount < 1 || !CURRENCIES.includes(currency) || subscription.currency && subscription.currency !== currency) return { owned, supported: false, problem: "Reader billing changes support a fixed monthly, quarterly or yearly price in a supported currency" };
	const periodEnd = item.current_period_end ?? subscription.current_period_end;
	return { owned, supported: true, problem: null, subscriptionId: subscription.id, customerId: reference(subscription.customer), priceId: price.id, currency, unitAmountMinor: price.unit_amount, interval: interval === "month" && count === 3 ? "quarter" : interval, periodEnd: Number.isSafeInteger(periodEnd) && periodEnd > 0 ? periodEnd : null, status: subscription.status, scheduleId: reference(subscription.schedule) };
}

export function getReaderPauseProblem(subscription, details, { ownedScheduleId = null, now = Date.now() } = {}) {
	if (!details.owned || !details.supported) return details.problem;
	if (subscription.status !== "active") return "Only an active paid subscription can schedule a pause";
	if (subscription.billing_mode?.type !== "flexible") return "This subscription uses classic billing. Manage it in Stripe; FlockStack will not migrate its billing mode automatically.";
	if (subscription.collection_method !== "charge_automatically" || subscription.pause_collection || subscription.pending_update || subscription.cancel_at_period_end || subscription.cancel_at) return "Resolve the subscription's pending billing, collection or cancellation changes before pausing";
	if (details.scheduleId && details.scheduleId !== ownedScheduleId) return "This subscription already has another schedule. Manage it in Stripe; FlockStack will not replace it.";
	if (!details.periodEnd || details.periodEnd * 1000 <= now + 60000) return "The paid billing period is ending. Refresh billing before scheduling a pause.";
	return null;
}

export function readerPauseScheduleParams(subscription, details, months) {
	if (!READER_PAUSE_MONTHS.includes(months) || !details.owned || !details.supported || !details.periodEnd) throw new Error("Choose a supported personal subscription and a pause of 1, 3 or 6 months");
	return {
		from_subscription: subscription.id,
		pause_schedules: [{
			pause: { pause_at: { type: "timestamp", timestamp: details.periodEnd }, settings: { type: "subscription", bill_for: { unused_time_from: { type: "none" }, outstanding_usage_through: { type: "none" } }, invoicing_behavior: "pending_invoice_item" } },
			resume: { resume_at: { type: "duration", duration: { interval: "month", interval_count: months } }, settings: { billing_cycle_anchor: "resume_at", payment_behavior: "resume_on_payment_success", proration_behavior: "none" } },
		}],
	};
}

export function readCancellationResponse(input) {
	const reason = input?.reason || null, comment = String(input?.comment ?? "").trim();
	if (!reason && !comment) return { response: null };
	if (input?.shareWithCreator !== true) return { problem: "Agree to share the optional cancellation response with the creator, or skip it" };
	if (reason && !CANCELLATION_REASONS.includes(reason) || comment.length > 1000) return { problem: "Choose a cancellation reason and keep the optional comment within 1000 characters" };
	return { response: { reason, comment: comment || null } };
}
