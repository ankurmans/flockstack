import "server-only";
import { scoped } from "@/lib/account-scope";
import { updatePaidAccess } from "@/lib/paid-access";
import { getGrantPaidUntil } from "@/lib/grants";
import Contact from "@/models/Contact";
import Newsletter from "@/models/Newsletter";

// Gift redemption calculates its duration from a specific contact snapshot. A conflicting source change must return to
// that calculation, while ordinary comp changes can reread and merge the current personal and group sources.
export async function grantAccess({ account, newsletter, contact, tierId, until, kind, note, giftId, giftReceiptId }) {
	const stale = new Error("Gift access changed");
	try {
		const result = await updatePaidAccess({ account, newsletter, contactId: contact._id, notify: true, source: kind, change: fresh => {
			if (giftReceiptId && ((fresh.grantRevision ?? 0) !== (contact.grantRevision ?? 0) || (fresh.paidAccessRevision ?? 0) !== (contact.paidAccessRevision ?? 0) || JSON.stringify([fresh.grant, fresh.paidUntil, fresh.subscriptionStatus, fresh.tier]) !== JSON.stringify([contact.grant, contact.paidUntil, contact.subscriptionStatus, contact.tier]))) throw stale;
			return { set: { grant: { kind, tierId, until, at: new Date(), ...(note && { note }), ...(giftId && { giftId: String(giftId) }) }, ...(giftReceiptId && { giftReceipts: { ...(fresh.giftReceipts ?? {}), [giftReceiptId]: until.toISOString() } }) }, inc: { grantRevision: 1 } };
		} });
		return result.contact;
	} catch (error) { if (error === stale) return null; throw error; }
}

export async function revokeGrant({ account, newsletter, contact }) {
	return (await updatePaidAccess({ account, newsletter, contactId: contact._id, notify: true, source: contact.grant?.kind, change: fresh => fresh.grant ? { unset: { grant: 1 }, inc: { grantRevision: 1 } } : { skip: true } })).contact;
}

export async function expireGrants({ now = new Date(), limit = 200 } = {}) {
	const contacts = await Contact.find({ "grant.until": { $lt: now } }).setOptions({ crossAccount: true }).limit(limit).lean();
	let expired = 0;
	for (const contact of contacts) {
		const newsletter = await Newsletter.findOne(scoped(contact.accountId, { _id: contact.newsletterId })).lean();
		if (!newsletter) continue;
		const result = await updatePaidAccess({ account: contact.accountId, newsletter, contactId: contact._id, notify: true, source: contact.grant?.kind, change: fresh => fresh.grant?.until && +new Date(fresh.grant.until) < +now ? { unset: { grant: 1 }, inc: { grantRevision: 1 }, expiredGrantDroveAccess: fresh.tier === "paid" && +new Date(fresh.paidUntil) === +getGrantPaidUntil(fresh.grant.until) } : { skip: true } });
		if (result.changed) expired++;
	}
	return { expired };
}
