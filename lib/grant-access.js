import "server-only";
import { scoped } from "@/lib/account-scope";
import { getGrantPaidUntil, isGrantDriving } from "@/lib/grants";
import { isPaidContact } from "@/lib/tiers";
import { findTier, getNewsletterTiers } from "@/lib/tier-rules";
import { emitSubscriberEvent } from "@/lib/webhooks";
import Contact from "@/models/Contact";

const SUBSCRIPTION_PAYING = new Set(["active", "trialing"]);

// Gives a contact paid access until a day, in a tier. A reader whose Stripe subscription is paying keeps it as it is: the
// grant waits and takes over when the subscription ends (lib/payments/subscriptions.js). Anyone else is paid from now on.
// Returns the contact as it is now.
export async function grantAccess({ account, newsletter, contact, tierId, until, kind, note, giftId }) {
	const wasPaid = isPaidContact(contact);
	const isStripePaying = wasPaid && SUBSCRIPTION_PAYING.has(contact.subscriptionStatus) && !isGrantDriving(contact);
	const grant = { kind, tierId, until, at: new Date(), ...(note && { note }), ...(giftId && { giftId: String(giftId) }) };
	const set = { grant, ...(!isStripePaying && { tier: "paid", paidTierId: tierId, paidUntil: getGrantPaidUntil(until), ...(!wasPaid && { paidSince: new Date() }) }) };
	await Contact.updateOne(scoped(account, { _id: contact._id }), { $set: set, ...(!isStripePaying && { $unset: { paidInterval: 1 } }) });
	const updated = { ...contact, ...set };
	if (!wasPaid && !isStripePaying) {
		const tier = findTier(getNewsletterTiers(newsletter), tierId);
		await emitSubscriberEvent("subscriber.upgraded", updated, { interval: null, tier: { id: tierId, name: tier?.name ?? null }, source: kind });
	}
	return updated;
}

// Takes the grant away. A reader whose grant was their only access drops to free.
export async function revokeGrant({ account, newsletter, contact }) {
	const grant = contact.grant;
	if (!grant) return contact;
	const wasDriving = isGrantDriving(contact);
	const set = wasDriving ? { tier: "free" } : {};
	await Contact.updateOne(scoped(account, { _id: contact._id }), { $unset: { grant: 1 }, ...(wasDriving && { $set: set }) });
	const updated = { ...contact, ...set, grant: undefined };
	if (wasDriving) {
		const tier = findTier(getNewsletterTiers(newsletter), grant.tierId);
		await emitSubscriberEvent("subscriber.downgraded", updated, { subscriptionStatus: null, tier: { id: grant.tierId, name: tier?.name ?? null }, source: grant.kind });
	}
	return updated;
}

// A grant that ran out: its reader drops to free (when nothing else pays) and the grant is cleared. Run from the hourly cron.
export async function expireGrants({ now = new Date(), limit = 200 } = {}) {
	const contacts = await Contact.find({ tier: "paid", "grant.until": { $lt: now } })
		.setOptions({ crossAccount: true })
		.limit(limit)
		.lean();
	let expired = 0;
	for (const contact of contacts) {
		const driving = contact.paidUntil && new Date(contact.paidUntil).getTime() === getGrantPaidUntil(contact.grant.until).getTime();
		const set = driving ? { tier: "free" } : null;
		await Contact.updateOne(scoped(contact.accountId, { _id: contact._id }), { $unset: { grant: 1 }, ...(set && { $set: set }) });
		if (driving) {
			await emitSubscriberEvent("subscriber.downgraded", { ...contact, ...set }, { subscriptionStatus: null, tier: { id: contact.grant.tierId, name: null }, source: contact.grant.kind });
		}
		expired++;
	}
	return { expired };
}
