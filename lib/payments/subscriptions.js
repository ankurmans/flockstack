import "server-only";
import { scoped } from "@/lib/account-scope";
import { getChargeAccount } from "@/lib/payments/connect";
import { stripeRequest } from "@/lib/payments/stripe-api";
import { isSendingEnabled } from "@/lib/config";
import { upsertContact } from "@/lib/contacts";
import { queueWelcomeEmail } from "@/lib/sending";
import { LEGACY_TIER_ID, LIFETIME_END, findTier, getContactTierId, getNewsletterTiers } from "@/lib/tier-rules";
import { getActiveGrant, getGrantPaidUntil, isGrantDriving } from "@/lib/grants";
import { isPaidContact } from "@/lib/tiers";
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

// month, quarter (3 months), year: what a subscription bills on.
function getInterval(subscription) {
	const item = subscription.items?.data?.[0];
	const recurring = item?.price?.recurring ?? item?.plan;
	const interval = recurring?.interval ?? null;
	if (interval === "month" && Number(recurring?.interval_count ?? 1) === 3) return "quarter";
	return interval === "year" || interval === "month" ? interval : null;
}

// What a subscription means for its reader: the tier, and until when it holds.
export function getSubscriptionTier(subscription) {
	const periodEnd = getPeriodEnd(subscription);
	const isPaid = PAID_STATUSES.has(subscription.status) && Boolean(periodEnd);
	const interval = getInterval(subscription);
	return {
		tier: isPaid ? "paid" : "free",
		paidUntil: periodEnd,
		paidInterval: interval,
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

// The reader's contact in this newsletter, made from their email when they have none. Paying is an explicit signup, so the
// contact is active without a confirmation email, and it brings back someone who had unsubscribed. An address that bounced
// or complained stays out (lib/contacts.js).
export async function ensurePaidContact({ newsletter, email, source = "paid" }) {
	const { contact, created } = await upsertContact({ newsletter, email, source, resubscribe: true, consent: { at: new Date() } });
	if (created && contact.status === "active" && isSendingEnabled()) {
		await queueWelcomeEmail({ newsletter, contact }).catch((error) => console.error(`[subscriptions] The welcome email for ${contact._id} failed:`, error.message));
	}
	return contact;
}

// The tier a subscription's metadata names; one made before tiers names none and is the legacy tier.
function readTierId(metadata, newsletter) {
	const tiers = getNewsletterTiers(newsletter);
	return findTier(tiers, metadata.tierId ?? LEGACY_TIER_ID) ? (metadata.tierId ?? LEGACY_TIER_ID) : (tiers[0]?.id ?? LEGACY_TIER_ID);
}

// Makes the reader's contact match their subscription: found by the subscription or the customer, else made from the
// customer's email. supporterName: what a founding member typed in Checkout for the supporters list.
async function syncSubscription({ account, subscription, email, supporterName }) {
	const { metadata = {} } = subscription;
	if (metadata.flockstack !== "1" || metadata.kind !== "paid_tier") return { ignored: "not a FlockStack subscription" };
	if (metadata.accountId !== String(account._id)) return { ignored: "another account's subscription" };
	const newsletter = isObjectIdString(metadata.newsletterId ?? "") ? await Newsletter.findOne(scoped(account, { _id: metadata.newsletterId })).lean() : null;
	if (!newsletter) return { ignored: "unknown newsletter" };

	let contact = await findSubscriptionContact({ account, newsletter, subscription });
	if (!contact) {
		const address = email ?? (await readCustomerEmail({ account, subscription }));
		if (!address) return { ignored: "no email for the customer" };
		contact = await ensurePaidContact({ newsletter, email: address });
	}

	const next = getSubscriptionTier(subscription);
	// A reader's older subscription ending doesn't undo the newer one they started.
	const isOther = contact.stripeSubscriptionId && contact.stripeSubscriptionId !== subscription.id;
	if (isOther && next.tier !== "paid" && contact.tier === "paid" && !isGrantDriving(contact)) return { ignored: "another subscription of the reader's is active" };

	if (next.tier !== "paid" && contact.paidInterval === "lifetime" && isPaidContact(contact)) return { ignored: "the reader paid for life" };
	const tierId = readTierId(metadata, newsletter);
	const grant = getActiveGrant(contact);
	const access = next.tier === "paid" ? null : grant;
	const set = {
		tier: next.tier === "paid" || access ? "paid" : "free",
		stripeSubscriptionId: subscription.id,
		subscriptionStatus: next.status,
		...(getCustomerId(subscription) && { stripeCustomerId: getCustomerId(subscription) }),
		...(next.tier === "paid" && { paidUntil: next.paidUntil, paidTierId: tierId, ...(next.paidInterval && { paidInterval: next.paidInterval }) }),
		...(access && { paidUntil: getGrantPaidUntil(access.until), paidTierId: access.tierId ?? tierId }),
		...(next.tier !== "paid" && !access && next.paidUntil && { paidUntil: next.paidUntil }),
		...(metadata.offerId && { offerId: metadata.offerId }),
		...(supporterName && { supporterName }),
		...(next.tier === "paid" && !isPaidContact(contact) && { paidSince: new Date() }),
	};
	await Contact.updateOne(scoped(account, { _id: contact._id }), {
		$set: set,
		...(access && { $unset: { paidInterval: 1 } }),
	});
	const wasPaid = isPaidContact(contact);
	const isPaid = set.tier === "paid";
	if (isPaid !== wasPaid) {
		const heldTierId = isPaid ? (set.paidTierId ?? tierId) : getContactTierId(contact);
		const tier = { id: heldTierId, name: findTier(getNewsletterTiers(newsletter), heldTierId)?.name ?? null };
		const updated = { ...contact, ...set };
		if (isPaid) await emitSubscriberEvent("subscriber.upgraded", updated, { interval: next.paidInterval ?? null, tier, source: access ? grant.kind : "stripe" });
		else await emitSubscriberEvent("subscriber.downgraded", updated, { subscriptionStatus: next.status ?? null, tier, source: "stripe" });
	}
	return { contactId: String(contact._id), tier: set.tier, tierId: set.paidTierId ?? null };
}

// A lifetime tier is one payment that never renews: the reader is paid until the end of the century, or until the charge is
// refunded (handleRefund).
async function syncLifetimeSession({ account, session }) {
	if (session.payment_status !== "paid") return { ignored: "not paid yet" };
	const { metadata = {} } = session;
	const newsletter = isObjectIdString(metadata.newsletterId ?? "") ? await Newsletter.findOne(scoped(account, { _id: metadata.newsletterId })).lean() : null;
	const email = normalizeEmail(session.customer_details?.email ?? session.customer_email ?? "");
	if (!newsletter || !email) return { ignored: newsletter ? "no email for the customer" : "unknown newsletter" };

	const contact = await ensurePaidContact({ newsletter, email });
	const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : (session.payment_intent?.id ?? undefined);
	if (contact.lifetimePaymentIntentId && contact.lifetimePaymentIntentId === paymentIntentId) return { contactId: String(contact._id), tier: "paid", duplicate: true };
	const tierId = readTierId(metadata, newsletter);
	const set = {
		tier: "paid",
		paidUntil: LIFETIME_END,
		paidInterval: "lifetime",
		paidTierId: tierId,
		...(paymentIntentId && { lifetimePaymentIntentId: paymentIntentId }),
		...(typeof session.customer === "string" && { stripeCustomerId: session.customer }),
		...(metadata.offerId && { offerId: metadata.offerId }),
		...(!isPaidContact(contact) && { paidSince: new Date() }),
	};
	await Contact.updateOne(scoped(account, { _id: contact._id }), { $set: set });
	if (!isPaidContact(contact) || contact.paidInterval !== "lifetime") {
		const tier = findTier(getNewsletterTiers(newsletter), tierId);
		await emitSubscriberEvent("subscriber.upgraded", { ...contact, ...set }, { interval: "lifetime", tier: { id: tierId, name: tier?.name ?? null }, source: "stripe" });
	}
	return { contactId: String(contact._id), tier: "paid", tierId };
}

// The latest state is read from Stripe rather than trusted from the event: events can arrive late or out of order, and
// the state they describe is one read away. email: a Checkout Session already knows it.
async function syncSubscriptionById({ account, subscriptionId, email, supporterName }) {
	if (typeof subscriptionId !== "string") return { ignored: "no subscription" };
	const subscription = await stripeRequest(`/v1/subscriptions/${subscriptionId}`, { account: getChargeAccount(account) });
	return syncSubscription({ account, subscription, email, supporterName });
}

// The name a founding member gave in Checkout's custom field for the supporters list.
function readSupporterName(session) {
	const field = session.custom_fields?.find((candidate) => candidate.key === "supportername");
	return String(field?.text?.value ?? "").replace(/[<>]/g, "").trim().slice(0, 60) || undefined;
}

export function syncPaidTierSession({ account, session }) {
	if (session.mode === "payment") return syncLifetimeSession({ account, session });
	const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
	return syncSubscriptionById({
		account,
		subscriptionId,
		email: normalizeEmail(session.customer_details?.email ?? session.customer_email ?? "") ?? undefined,
		supporterName: readSupporterName(session),
	});
}

function handleSubscription({ account, object }) {
	return syncSubscriptionById({ account, subscriptionId: object.id });
}

function handleInvoice({ account, object }) {
	const subscriptionId = object.subscription ?? object.parent?.subscription_details?.subscription;
	return syncSubscriptionById({ account, subscriptionId: typeof subscriptionId === "string" ? subscriptionId : subscriptionId?.id });
}

// A full refund of a lifetime payment ends that access, as a refunded product's download link stops.
async function handleLifetimeRefund({ account, object }) {
	const isFull = object.refunded === true || (object.amount > 0 && object.amount_refunded >= object.amount);
	const contact = typeof object.payment_intent === "string" ? await Contact.findOne(scoped(account, { lifetimePaymentIntentId: object.payment_intent })).lean() : null;
	if (!contact) return { ignored: "no lifetime reader for this charge" };
	if (!isFull) return { ignored: "a partial refund" };
	const grant = getActiveGrant(contact);
	const set = grant ? { tier: "paid", paidUntil: getGrantPaidUntil(grant.until), paidTierId: grant.tierId } : { tier: "free" };
	await Contact.updateOne(scoped(account, { _id: contact._id }), { $set: set, $unset: { paidInterval: 1, lifetimePaymentIntentId: 1 } });
	if (!grant) {
		const newsletter = await Newsletter.findOne(scoped(account, { _id: contact.newsletterId })).lean();
		const tierId = getContactTierId(contact);
		await emitSubscriberEvent("subscriber.downgraded", { ...contact, ...set }, { subscriptionStatus: null, tier: { id: tierId, name: findTier(getNewsletterTiers(newsletter), tierId)?.name ?? null }, source: "stripe" });
	}
	return { contactId: String(contact._id), refunded: true };
}

export const subscriptionHandlers = {
	"customer.subscription.created": handleSubscription,
	"customer.subscription.updated": handleSubscription,
	"customer.subscription.deleted": handleSubscription,
	"invoice.paid": handleInvoice,
	"invoice.payment_failed": handleInvoice,
};
export { handleLifetimeRefund };

// Where a lifetime payment's refund comes from on a self-hosted server.
export async function findLifetimeAccountId(object) {
	if (typeof object.payment_intent !== "string") return null;
	const contact = await Contact.findOne({ lifetimePaymentIntentId: object.payment_intent }).select({ accountId: 1 }).setOptions({ crossAccount: true }).lean();
	return contact?.accountId ?? null;
}

// Where a subscription's or an invoice's event comes from on a self-hosted server.
export async function findSubscriptionAccountId(object) {
	const subscriptionId = object.object === "subscription" ? object.id : (object.subscription ?? object.parent?.subscription_details?.subscription);
	if (typeof subscriptionId !== "string") return null;
	const contact = await Contact.findOne({ stripeSubscriptionId: subscriptionId }).select({ accountId: 1 }).setOptions({ crossAccount: true }).lean();
	return contact?.accountId ?? null;
}
