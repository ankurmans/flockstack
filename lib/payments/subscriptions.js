import "server-only";
import { scoped } from "@/lib/account-scope";
import { getChargeAccount } from "@/lib/payments/connect";
import { stripeRequest } from "@/lib/payments/stripe-api";
import { isSendingEnabled } from "@/lib/config";
import { upsertContact } from "@/lib/contacts";
import { queueWelcomeEmail } from "@/lib/sending";
import { isObjectIdString, normalizeEmail } from "@/lib/validation";
import { emitSubscriberEvent } from "@/lib/webhooks";
import Contact from "@/models/Contact";
import Newsletter from "@/models/Newsletter";

// A reader is paid while Stripe says their subscription is active or in its free trial. Anything else drops them to free
// at once, a failed renewal (past_due) included: Stripe's smart retries bring them back through the next event if the
// card works. The paid period's end (paidUntil) is the safety net if a cancellation event is ever missed.
const PAID_STATUSES = new Set(["active", "trialing"]);

// Stripe moved the period from the subscription to its items in 2025; either API version reaches here.
function getPeriodEnd(subscription) {
	const seconds = subscription.current_period_end ?? subscription.items?.data?.[0]?.current_period_end;
	return Number.isFinite(seconds) ? new Date(seconds * 1000) : null;
}

function getInterval(subscription) {
	const item = subscription.items?.data?.[0];
	return item?.price?.recurring?.interval ?? item?.plan?.interval ?? null;
}

// What a subscription means for its reader: the tier, and until when it holds.
export function getSubscriptionTier(subscription) {
	const periodEnd = getPeriodEnd(subscription);
	const isPaid = PAID_STATUSES.has(subscription.status) && Boolean(periodEnd);
	const interval = getInterval(subscription);
	return {
		tier: isPaid ? "paid" : "free",
		paidUntil: periodEnd,
		paidInterval: interval === "year" || interval === "month" ? interval : null,
		status: subscription.status,
	};
}

function getCustomerId(subscription) {
	return typeof subscription.customer === "string" ? subscription.customer : (subscription.customer?.id ?? null);
}

async function findSubscriptionContact({ account, newsletter, subscription }) {
	const bySubscription = await Contact.findOne(scoped(account, { newsletterId: newsletter._id, stripeSubscriptionId: subscription.id })).lean();
	if (bySubscription) return bySubscription;
	const customerId = getCustomerId(subscription);
	if (!customerId) return null;
	return Contact.findOne(scoped(account, { newsletterId: newsletter._id, stripeCustomerId: customerId })).lean();
}

async function readCustomerEmail({ account, subscription }) {
	const customerId = getCustomerId(subscription);
	if (!customerId) return null;
	const customer = await stripeRequest(`/v1/customers/${customerId}`, { account: getChargeAccount(account) });
	return normalizeEmail(customer.email ?? "");
}

// Makes the reader's contact match their subscription: found by the subscription or the customer, else made from the
// customer's email. Paying is an explicit signup, so the contact is active without a confirmation email, and it brings
// back someone who had unsubscribed. An address that bounced or complained stays out (lib/contacts.js).
async function syncSubscription({ account, subscription, email }) {
	const { metadata = {} } = subscription;
	if (metadata.flockstack !== "1" || metadata.kind !== "paid_tier") return { ignored: "not a FlockStack subscription" };
	if (metadata.accountId !== String(account._id)) return { ignored: "another account's subscription" };
	const newsletter = isObjectIdString(metadata.newsletterId ?? "") ? await Newsletter.findOne(scoped(account, { _id: metadata.newsletterId })).lean() : null;
	if (!newsletter) return { ignored: "unknown newsletter" };

	let contact = await findSubscriptionContact({ account, newsletter, subscription });
	if (!contact) {
		const address = email ?? (await readCustomerEmail({ account, subscription }));
		if (!address) return { ignored: "no email for the customer" };
		const { contact: made, created } = await upsertContact({ newsletter, email: address, source: "paid", resubscribe: true, consent: { at: new Date() } });
		contact = made;
		if (created && contact.status === "active" && isSendingEnabled()) {
			await queueWelcomeEmail({ newsletter, contact }).catch((error) => console.error(`[subscriptions] The welcome email for ${contact._id} failed:`, error.message));
		}
	}

	const next = getSubscriptionTier(subscription);
	// A reader's older subscription ending doesn't undo the newer one they started.
	const isOther = contact.stripeSubscriptionId && contact.stripeSubscriptionId !== subscription.id;
	if (isOther && next.tier !== "paid" && contact.tier === "paid") return { ignored: "another subscription of the reader's is active" };

	const set = {
		tier: next.tier,
		stripeSubscriptionId: subscription.id,
		subscriptionStatus: next.status,
		...(getCustomerId(subscription) && { stripeCustomerId: getCustomerId(subscription) }),
		...(next.paidUntil && { paidUntil: next.paidUntil }),
		...(next.paidInterval && { paidInterval: next.paidInterval }),
		...(next.tier === "paid" && contact.tier !== "paid" && { paidSince: new Date() }),
	};
	await Contact.updateOne(scoped(account, { _id: contact._id }), { $set: set });
	if (next.tier !== (contact.tier ?? "free")) {
		const updated = { ...contact, ...set };
		if (next.tier === "paid") await emitSubscriberEvent("subscriber.upgraded", updated, { interval: next.paidInterval });
		else await emitSubscriberEvent("subscriber.downgraded", updated, { subscriptionStatus: next.status ?? null });
	}
	return { contactId: String(contact._id), tier: next.tier };
}

// The latest state is read from Stripe rather than trusted from the event: events can arrive late or out of order, and
// the state they describe is one read away. email: a Checkout Session already knows it.
async function syncSubscriptionById({ account, subscriptionId, email }) {
	if (typeof subscriptionId !== "string") return { ignored: "no subscription" };
	const subscription = await stripeRequest(`/v1/subscriptions/${subscriptionId}`, { account: getChargeAccount(account) });
	return syncSubscription({ account, subscription, email });
}

export function syncPaidTierSession({ account, session }) {
	const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
	return syncSubscriptionById({ account, subscriptionId, email: normalizeEmail(session.customer_details?.email ?? session.customer_email ?? "") ?? undefined });
}

function handleSubscription({ account, object }) {
	return syncSubscriptionById({ account, subscriptionId: object.id });
}

function handleInvoice({ account, object }) {
	const subscriptionId = object.subscription ?? object.parent?.subscription_details?.subscription;
	return syncSubscriptionById({ account, subscriptionId: typeof subscriptionId === "string" ? subscriptionId : subscriptionId?.id });
}

export const subscriptionHandlers = {
	"customer.subscription.created": handleSubscription,
	"customer.subscription.updated": handleSubscription,
	"customer.subscription.deleted": handleSubscription,
	"invoice.paid": handleInvoice,
	"invoice.payment_failed": handleInvoice,
};

// Where a subscription's or an invoice's event comes from on a self-hosted server.
export async function findSubscriptionAccountId(object) {
	const subscriptionId = object.object === "subscription" ? object.id : (object.subscription ?? object.parent?.subscription_details?.subscription);
	if (typeof subscriptionId !== "string") return null;
	const contact = await Contact.findOne({ stripeSubscriptionId: subscriptionId }).select({ accountId: 1 }).setOptions({ crossAccount: true }).lean();
	return contact?.accountId ?? null;
}
