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
	contact = effectivePaidContact(contact, now);
	return contact?.tier === "paid" && toTime(contact.paidUntil) + PAID_GRACE_MS > now;
}

// A group's exact paid period can expire between jobs. Preserve a still-valid independent source in pure audience
// queries and labels without scanning or rewriting every group reader before each preview or send.
export function effectivePaidContact(contact, now = Date.now()) {
	if (contact?.paidSource !== "group" || toTime(contact.paidUntil) + PAID_GRACE_MS > now) return contact;
	const personal = contact.paidPersonal;
	const personalPaid = personal && ["active", "trialing"].includes(personal.status) && toTime(personal.until) + PAID_GRACE_MS > now;
	const grant = contact.grant;
	if (grant && toTime(grant.until) > now && (!personalPaid || personal.kind === "legacy")) return { ...contact, tier: "paid", paidSource: "grant", paidUntil: new Date(toTime(grant.until) - PAID_GRACE_MS), paidTierId: grant.tierId || "paid" };
	if (personalPaid) return { ...contact, tier: "paid", paidSource: "personal", paidUntil: personal.until, paidTierId: personal.tierId || "paid" };
	return { ...contact, tier: "free" };
}

function sourceTierFilter(filter, path) {
	if (!filter) return {};
	return Object.fromEntries(Object.entries(filter).map(([key, value]) => [key === "paidTierId" ? path : key, Array.isArray(value) && key.startsWith("$") ? value.map(item => sourceTierFilter(item, path)) : value]));
}

// The part of the audience query (lib/audience.js) that picks a tier. A paid contact whose period ran out counts as free.
// tierFilter: lib/tier-rules.js tierIdFilter, to reach only some paid tiers.
export function audienceTierFilter(audience, now = Date.now(), tierFilter = null) {
	const cutoff = new Date(now - PAID_GRACE_MS);
	const expiredGroup = { paidSource: "group", $or: [{ paidUntil: null }, { paidUntil: { $lte: cutoff } }] };
	const personal = { "paidPersonal.status": { $in: ["active", "trialing"] }, "paidPersonal.until": { $gt: cutoff } };
	const grant = { "grant.until": { $gt: new Date(now) } };
	const noPersonal = { $or: [{ "paidPersonal.status": { $nin: ["active", "trialing"] } }, { "paidPersonal.until": null }, { "paidPersonal.until": { $lte: cutoff } }] };
	const noGrant = { $or: [{ "grant.until": null }, { "grant.until": { $lte: new Date(now) } }] };
	if (audience === "paid") return { tier: "paid", $or: [
		{ tier: "paid", paidUntil: { $gt: cutoff }, ...tierFilter },
		{ $and: [expiredGroup, personal, { $or: [noGrant, { "paidPersonal.kind": { $ne: "legacy" } }] }, sourceTierFilter(tierFilter, "paidPersonal.tierId")] },
		{ $and: [expiredGroup, grant, { $or: [noPersonal, { "paidPersonal.kind": "legacy" }] }, sourceTierFilter(tierFilter, "grant.tierId")] },
	] };
	if (audience === "free") return { $or: [{ $and: [{ $or: [{ tier: { $ne: "paid" } }, { paidUntil: null }, { paidUntil: { $lte: cutoff } }] }, { $or: [{ paidSource: { $ne: "group" } }, { paidUntil: { $gt: cutoff } }, { $and: [noPersonal, noGrant] }] }] }] };
	return {};
}

// Whether a paid contact holds one of the tiers; a campaign without tiers reaches every paid tier.
export function isInPaidTiers(contact, tierIds, now = Date.now()) {
	contact = effectivePaidContact(contact, now);
	return !tierIds?.length || tierIds.includes(contact?.paidTierId || "paid");
}

export function getAudienceLabel(audience) {
	return { all: "Everyone", free: "Free subscribers", paid: "Paid subscribers" }[audience] ?? "Everyone";
}
