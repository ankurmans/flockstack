import "server-only";
import { scoped } from "@/lib/account-scope";
import { actionError } from "@/lib/actions/errors";
import { GROUP_LIMITS } from "@/lib/group-subscription-rules";
import { paidAccessUpdate, readPersonalAccess, resolvePaidAccess } from "@/lib/paid-access-rules";
import { findTier, getNewsletterTiers } from "@/lib/tier-rules";
import { isPaidContact } from "@/lib/tiers";
import Contact from "@/models/Contact";
import GroupSubscription from "@/models/GroupSubscription";

async function readGroups(account, newsletter, contact) {
	const ids = [...new Set((contact.groupIds ?? []).map(String))];
	if (ids.length > GROUP_LIMITS.groupsPerContact) throw actionError("conflict", "A reader can belong to at most 20 groups. Revoke a membership before accepting another.");
	return ids.length ? GroupSubscription.find(scoped(account, { newsletterId: newsletter._id, _id: { $in: ids } })).lean() : [];
}

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

// Every paid source is merged against the same current contact. A projection never replaces the underlying personal
// subscription, and retries reread group funding so revocation and an individual renewal cannot overwrite each other.
// change can read current provider state, but must never charge, create provider objects or send: a conflict reruns it.
export async function updatePaidAccess({ account, newsletter, contactId, change = () => ({}), notify = false, source: eventSource }) {
	for (let attempt = 0; attempt < 5; attempt++) {
		const fresh = await Contact.findOne(scoped(account, { newsletterId: newsletter._id, _id: contactId })).lean();
		if (!fresh) throw actionError("not_found", "Contact not found");
		const mutation = await change(fresh);
		if (mutation.skip) return { contact: fresh, changed: false, ...(mutation.ignored && { ignored: mutation.ignored }) };
		const otherSet = { paidPersonal: readPersonalAccess(fresh), ...(mutation.set ?? {}) }, otherUnset = mutation.unset ?? {};
		if ([...Object.keys(otherSet), ...Object.keys(otherUnset)].some(key => key.includes("."))) throw new Error("Paid access changes must replace whole source fields");
		const draft = { ...fresh, ...otherSet };
		for (const key of Object.keys(otherUnset)) delete draft[key];
		const groups = await readGroups(account, newsletter, draft);
		if (draft.groupIds?.length) otherSet.groupIds = groups.filter(group => group.status !== "canceled" && (group.seats ?? []).some(seat => ["active", "accepting"].includes(seat.status) && seat.consentedAt && String(seat.contactId) === String(fresh._id) && seat.email === fresh.email)).map(group => group._id);
		const state = resolvePaidAccess({ contact: draft, newsletter, groups });
		const projected = paidAccessUpdate(state);
		const set = { ...otherSet, ...projected.set }, unset = { ...otherUnset, ...projected.unset };
		for (const key of Object.keys(unset)) delete set[key];
		const continuity = resolvePaidAccess({ contact: fresh, newsletter });
		const wasPaid = isPaidContact(fresh) || Boolean(continuity.access) || mutation.expiredGrantDroveAccess === true;
		if (state.access && !wasPaid) set.paidSince = new Date();
		const unchanged = Object.entries(set).every(([key, value]) => same(fresh[key], value)) && Object.keys(unset).every(key => fresh[key] === undefined);
		if (unchanged && !mutation.inc && !mutation.forceRevision) return { contact: fresh, changed: false };
		set.updatedAt = new Date();
		const revision = fresh.paidAccessRevision ?? 0;
		const guard = revision ? { paidAccessRevision: revision } : { $or: [{ paidAccessRevision: 0 }, { paidAccessRevision: { $exists: false } }] };
		const saved = await Contact.updateOne(scoped(account, { _id: fresh._id, newsletterId: newsletter._id, status: fresh.status, ...guard, ...(mutation.guard ?? {}) }), { $set: set, ...(Object.keys(unset).length && { $unset: unset }), $inc: { ...(mutation.inc ?? {}), paidAccessRevision: 1 } });
		if (!saved.matchedCount) continue;
		const updated = { ...fresh, ...set, paidAccessRevision: revision + 1 };
		for (const [key, amount] of Object.entries(mutation.inc ?? {})) if (key !== "paidAccessRevision") updated[key] = (fresh[key] ?? 0) + amount;
		for (const key of Object.keys(unset)) delete updated[key];
		if (notify && wasPaid !== Boolean(state.access)) {
			const id = state.access?.tierId ?? fresh.paidTierId;
			const tier = { id, name: findTier(getNewsletterTiers(newsletter), id)?.name ?? null };
			const source = eventSource ?? (state.access?.source === "group" || fresh.paidSource === "group" ? "group" : state.access?.source === "grant" ? updated.grant?.kind ?? "group" : "stripe");
			await (await import("@/lib/tier-events")).announceTierChange(state.access ? "upgraded" : "downgraded", updated, { interval: state.access?.interval ?? null, tier, source, ...(!state.access && { subscriptionStatus: source === "group" ? null : updated.subscriptionStatus ?? null }) });
		}
		return { contact: updated, changed: true };
	}
	throw actionError("conflict", "This reader's paid access changed. Try again.");
}

export async function refreshGroupReader(newsletter, contact) {
	if (!contact?.groupIds?.length && contact?.paidSource !== "group") return contact;
	return (await updatePaidAccess({ account: newsletter.accountId, newsletter, contactId: contact._id, notify: true })).contact;
}
