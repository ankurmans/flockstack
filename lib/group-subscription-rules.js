import { getGrantPaidUntil } from "./grants.js";

export const GROUP_LIMITS = { minSeats: 2, maxSeats: 100, groupsPerContact: 20, groupsPerNewsletter: 100 };
const time = value => {
	const result = value ? new Date(value).getTime() : NaN;
	return Number.isFinite(result) ? result : null;
};
const reference = value => typeof value === "string" ? value : value?.id ?? null;
const quantity = value => Number.isSafeInteger(value) && value >= 0 && value <= GROUP_LIMITS.maxSeats ? value : null;
const periodEnd = subscription => {
	const value = subscription.current_period_end ?? subscription.items?.data?.[0]?.current_period_end;
	return Number.isSafeInteger(value) && value > 0 && Number.isFinite(new Date(value * 1000).getTime()) ? value * 1000 : null;
};
const invoiceSubscription = invoice => reference(invoice?.subscription ?? invoice?.parent?.subscription_details?.subscription);

// This is an access decision, not a financial report. Only a verified recurring invoice can extend funded seats.
export function readGroupFunding({ subscription, invoice, previous = {}, now = Date.now() }) {
	const unsupported = reason => ({ supported: false, reason });
	if (!subscription?.id || !subscription.status) return unsupported("The subscription is incomplete");
	const items = subscription.items;
	if (!Array.isArray(items?.data) || items.has_more || items.data.length !== 1) return unsupported("A group needs one licensed recurring price");
	const item = items.data[0], price = item.price;
	const licensed = quantity(item.quantity);
	const recurring = price?.recurring;
	if (licensed === null || !price?.id || !/^[a-z]{3}$/.test(price.currency ?? "") || price.billing_scheme !== "per_unit" || price.transform_quantity || recurring?.usage_type !== "licensed" || !Number.isSafeInteger(price.unit_amount) || price.unit_amount <= 0) return unsupported("The licensed price or quantity is unsupported");
	const option = recurring.interval === "year" && recurring.interval_count === 1 ? "year" : recurring.interval === "month" && recurring.interval_count === 1 ? "month" : recurring.interval === "month" && recurring.interval_count === 3 ? "quarter" : null;
	if (!option || previous.priceId && previous.priceId !== price.id || previous.currency && previous.currency !== price.currency || previous.option && previous.option !== option) return unsupported("The group's price changed outside FlockStack");
	const end = periodEnd(subscription);
	if (!end) return unsupported("The billing period is unknown");
	const active = subscription.status === "active";
	const lines = invoice?.lines?.data;
	const proof = active && Boolean(invoice?.id) && invoice.currency === price.currency && invoice?.status === "paid" && invoice.paid !== false && invoiceSubscription(invoice) === subscription.id && Array.isArray(lines) && lines.some(line =>
		reference(line.price ?? line.pricing?.price_details?.price) === price.id && line.quantity === licensed && Number.isSafeInteger(line.amount) && line.amount >= 0 && Number.isSafeInteger(line.period?.end) && line.period.end * 1000 >= end
	);
	const priorEnd = time(previous.paidUntil), priorQuantity = quantity(previous.capacity);
	const until = proof ? end : priorEnd && priorQuantity !== null ? Math.min(priorEnd, end) : null;
	const capacity = active && until && until > now ? proof ? licensed : Math.min(priorQuantity ?? 0, licensed) : 0;
	return { supported: true, status: subscription.status, capacity, paidUntil: until ? new Date(until) : null, providerPeriodEnd: new Date(end), declaredQuantity: licensed, priceId: price.id, option, currency: price.currency, verifiedInvoiceId: proof ? invoice.id : previous.verifiedInvoiceId ?? null, paymentVerified: Boolean(proof) };
}

export function groupSeatEntitlement(group, seatId, contact, now = Date.now()) {
	if (!group?._id || group.status !== "active" || !group.accountId || !group.newsletterId || !contact?.accountId || !contact.newsletterId || group.subscriptionStatus !== "active" || !group.tierId || !contact?._id || !contact.email || contact.status !== "active" || String(contact.accountId) !== String(group.accountId) || String(contact.newsletterId) !== String(group.newsletterId)) return null;
	const end = time(group.paidUntil), capacity = quantity(group.capacity);
	if (!end || end <= now || !capacity) return null;
	const licensed = (group.seats ?? []).filter(seat => seat.status !== "revoked").slice(0, capacity);
	const seat = licensed.find(seat => seat.id === seatId);
	const consent = time(seat?.consentedAt);
	if (!seat || seat.status !== "active" || !seat.contactId || String(seat.contactId) !== String(contact._id) || seat.email !== contact.email || !consent || consent > now) return null;
	return { kind: "group", groupId: String(group._id), seatId: seat.id, tierId: group.tierId, until: new Date(end) };
}

export function groupAccessProjection(access) {
	return { tier: "paid", paidTierId: access.tierId, paidUntil: getGrantPaidUntil(access.until) };
}
