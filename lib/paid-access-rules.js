import { getActiveGrant, getGrantPaidUntil, isGrantDriving } from "./grants.js";
import { groupSeatEntitlement } from "./group-subscription-rules.js";
import { getNewsletterTiers, LEGACY_TIER_ID } from "./tier-rules.js";
import { isPaidContact } from "./tiers.js";

const paying = new Set(["active", "trialing"]);
const date = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value) : null;

// Before groups existed, a contact's projected fields were also the only personal access snapshot. Never capture a group
// projection as an individual subscription. Saved legacy access is finite and is not evidence of a Stripe invoice.
export function readPersonalAccess(contact) {
	if (contact.paidPersonal === null) return null;
	if (contact.paidPersonal?.kind) return contact.paidPersonal;
	if (["group", "grant"].includes(contact.paidSource) || isGrantDriving(contact) || contact.tier !== "paid" || !date(contact.paidUntil)) return null;
	const kind = contact.paidInterval === "lifetime" ? "lifetime" : contact.stripeSubscriptionId || paying.has(contact.subscriptionStatus) ? "stripe" : "legacy";
	return { kind, tierId: contact.paidTierId || LEGACY_TIER_ID, until: date(contact.paidUntil), ...(contact.paidInterval && { interval: contact.paidInterval }), status: kind === "legacy" || kind === "lifetime" ? "active" : contact.subscriptionStatus ?? "active", ...(contact.stripeSubscriptionId && { subscriptionId: contact.stripeSubscriptionId }) };
}

export function resolvePaidAccess({ contact, newsletter, groups = [], now = Date.now() }) {
	const personal = readPersonalAccess(contact);
	const tiers = getNewsletterTiers(newsletter);
	const rank = id => Math.max(0, tiers.findIndex(tier => tier.id === id));
	let chosen = null;
	if (personal && paying.has(personal.status) && isPaidContact({ tier: "paid", paidUntil: personal.until }, now)) chosen = { source: "personal", tierId: personal.tierId || LEGACY_TIER_ID, until: date(personal.until), paidUntil: date(personal.until), interval: personal.interval ?? null };
	const grant = getActiveGrant(contact, now);
	if (grant && ["comp", "gift"].includes(grant.kind) && (!chosen || personal?.kind === "legacy")) chosen = { source: "grant", tierId: grant.tierId || LEGACY_TIER_ID, until: date(grant.until), paidUntil: getGrantPaidUntil(grant.until), interval: null };
	const eligible = [];
	for (const group of groups) {
		if (!tiers.some(tier => tier.id === group.tierId)) continue;
		for (const seat of group.seats ?? []) {
			const access = groupSeatEntitlement(group, seat.id, contact, now);
			if (access) eligible.push(access);
		}
	}
	eligible.sort((left, right) => rank(right.tierId) - rank(left.tierId) || +right.until - +left.until || left.groupId.localeCompare(right.groupId));
	const group = eligible[0];
	if (group && (!chosen || rank(group.tierId) > rank(chosen.tierId))) chosen = { source: "group", tierId: group.tierId, until: group.until, paidUntil: getGrantPaidUntil(group.until), interval: null, group };
	return { personal, access: chosen };
}

export function paidAccessUpdate({ personal, access }) {
	const set = { tier: access ? "paid" : "free", ...(personal && { paidPersonal: personal }), ...(access && { paidSource: access.source, paidTierId: access.tierId, paidUntil: access.paidUntil }), ...(access?.interval && { paidInterval: access.interval }), ...(access?.group && { groupAccess: { groupId: access.group.groupId, seatId: access.group.seatId, tierId: access.group.tierId, until: access.group.until } }) };
	const unset = { ...(!access && { paidSource: 1 }), ...(!access?.interval && { paidInterval: 1 }), ...(!access?.group && { groupAccess: 1 }) };
	return { set, unset };
}
