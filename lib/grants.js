import { PAID_GRACE_MS } from "./tiers.js";

// Paid access that doesn't come from a Stripe subscription: a comp the writer gave by hand, or a gift someone bought
// (contact.grant, with the tier it opens and when it ends). A paying subscription wins while it lasts; the grant holds
// after it, and a reader with none is paid by the grant alone.
function toTime(value) {
	const time = value ? new Date(value).getTime() : Number.NaN;
	return Number.isFinite(time) ? time : 0;
}

export function getActiveGrant(contact, now = Date.now()) {
	return contact?.grant?.until && toTime(contact.grant.until) > now ? contact.grant : null;
}

// Audience queries read paidUntil with the grace for a missed Stripe event (lib/tiers.js); a grant ends on its day, so what
// is stored is that day less the grace.
export function getGrantPaidUntil(until) {
	return new Date(toTime(until) - PAID_GRACE_MS);
}

// The contact is paid by their grant now, not by a subscription.
export function isGrantDriving(contact, now = Date.now()) {
	const grant = getActiveGrant(contact, now);
	return Boolean(grant) && contact.tier === "paid" && toTime(contact.paidUntil) === toTime(getGrantPaidUntil(grant.until));
}

// When paid access ends, as a reader and a writer see it.
export function getAccessEnd(contact) {
	return isGrantDriving(contact) ? contact.grant.until : (contact.paidUntil ?? null);
}
