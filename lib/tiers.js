// A newsletter with a paid tier has two kinds of readers: free ones, and paid ones whose subscription Stripe keeps in sync
// (lib/payments/subscriptions.js). A campaign goes to everyone, to free readers only, or to paid readers only.
export const CONTACT_TIERS = ["free", "paid"];
export const AUDIENCES = ["all", "free", "paid"];
const DAY_MS = 86_400_000;
// Stripe's webhook can lag or miss a renewal, so a paid reader stays paid a little past the period they paid for.
export const PAID_GRACE_MS = 3 * DAY_MS;

function toTime(value) {
	const time = value ? new Date(value).getTime() : Number.NaN;
	return Number.isFinite(time) ? time : 0;
}

// Paid, and paid up: a missing cancellation event can't keep someone paid for ever.
export function isPaidContact(contact, now = Date.now()) {
	return contact?.tier === "paid" && toTime(contact.paidUntil) + PAID_GRACE_MS > now;
}

// The part of the audience query (lib/audience.js) that picks a tier. A paid contact whose period ran out counts as free.
export function audienceTierFilter(audience, now = Date.now()) {
	const cutoff = new Date(now - PAID_GRACE_MS);
	if (audience === "paid") return { tier: "paid", paidUntil: { $gt: cutoff } };
	if (audience === "free") return { $or: [{ tier: { $ne: "paid" } }, { paidUntil: null }, { paidUntil: { $lte: cutoff } }] };
	return {};
}

export function getAudienceLabel(audience) {
	return { all: "Everyone", free: "Free subscribers", paid: "Paid subscribers" }[audience] ?? "Everyone";
}
