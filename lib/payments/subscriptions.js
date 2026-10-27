import "server-only";
import { randomUUID } from "node:crypto";
import { actionError } from "@/lib/actions/errors";
import { updatePaidAccess } from "@/lib/paid-access";
import { readPersonalAccess } from "@/lib/paid-access-rules";
import { scoped } from "@/lib/account-scope";
import { getChargeAccount } from "@/lib/payments/connect";
import { stripeRequest } from "@/lib/payments/stripe-api";
import { isSendingEnabled } from "@/lib/config";
import { upsertContact } from "@/lib/contacts";
import { queueWelcomeEmail } from "@/lib/sending";
import { LEGACY_TIER_ID, LIFETIME_END, findTier, getNewsletterTiers } from "@/lib/tier-rules";
import { isPaidContact } from "@/lib/tiers";
import { isObjectIdString, normalizeEmail } from "@/lib/validation";
import { isPaidTrialReady } from "@/lib/payments/paid-trials";
import Contact from "@/models/Contact";
import Newsletter from "@/models/Newsletter";

// A reader is paid while Stripe says their subscription is active or in its free trial. Anything else drops them to free
// at once, a failed renewal (past_due) included: Stripe's smart retries bring them back through the next event if the
// card works. The paid period's end (paidUntil) is the safety net if a cancellation event is ever missed.
const PAID_STATUSES = new Set(["active", "trialing"]);

// Stripe moved the period from the subscription to its items in 2025; either API version reaches here.
function getPeriodEnd(subscription) {
	const seconds = (subscription.status === "trialing" && Number.isFinite(subscription.trial_end) ? subscription.trial_end : null) ?? subscription.items?.data?.[0]?.current_period_end ?? subscription.current_period_end;
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
async function syncSubscription({ account, subscription, email, supporterName, event = null, invoice = null, observedAt = new Date(), personalLease, leaseContactId }) {
	let { metadata = {} } = subscription;
	let isImported = false;
	if (metadata.flockstack !== "1") {
		const ImportedSubscription = (await import("@/models/ImportedSubscription")).default;
		const mapped = await ImportedSubscription.findOne(scoped(account, { stripeSubscriptionId: subscription.id, chargeAccount: getChargeAccount(account) ?? "direct" })).lean();
		if (mapped) { isImported = true; metadata = { flockstack: "1", kind: "paid_tier", accountId: String(account._id), newsletterId: String(mapped.newsletterId), tierId: mapped.tierId }; }
	}
	if (metadata.flockstack !== "1" || metadata.kind !== "paid_tier") return { ignored: "not a FlockStack subscription" };
	if (metadata.accountId !== String(account._id)) return { ignored: "another account's subscription" };
	const newsletter = isObjectIdString(metadata.newsletterId ?? "") ? await Newsletter.findOne(scoped(account, { _id: metadata.newsletterId })).lean() : null;
	if (!newsletter) return { ignored: "unknown newsletter" };
	try {
		await (await import("@/lib/subscription-revenue")).captureSubscriptionFinancial({ account, newsletter, subscription: { ...subscription, metadata }, event, invoice, observedAt });
	} catch { console.error(`[subscription-revenue] Reporting module unavailable for account ${account._id}`); }
	if (!await isPaidTrialReady({ account, subscription })) return { ignored: "trial access fee has not been paid" };

	let contact = await findSubscriptionContact({ account, newsletter, subscription });
	if (!contact && isImported) return { ignored: "imported reader missing; no automatic signup" };
	if (!contact) {
		const address = email ?? (await readCustomerEmail({ account, subscription }));
		if (!address) return { ignored: "no email for the customer" };
		contact = await ensurePaidContact({ newsletter, email: address });
	}

	if (!personalLease || String(leaseContactId) !== String(contact._id)) {
		const lease = randomUUID();
		const claimed = await Contact.updateOne(scoped(account, { _id: contact._id }), { $set: { paidPersonalLease: lease } });
		if (!claimed.matchedCount) return { ignored: "reader deleted during billing refresh" };
		const currentAt = new Date();
		const current = await stripeRequest(`/v1/subscriptions/${subscription.id}`, { account: getChargeAccount(account) });
		return syncSubscription({ account, subscription: current, email, supporterName, event, invoice, observedAt: currentAt, personalLease: lease, leaseContactId: contact._id });
	}
	const next = getSubscriptionTier(subscription), tierId = readTierId(metadata, newsletter);
	const result = await updatePaidAccess({ account, newsletter, contactId: contact._id, notify: true, source: metadata.pledgeId ? "pledge" : undefined, change: fresh => {
		if (fresh.paidPersonalLease !== personalLease) throw actionError("conflict", "A newer billing refresh is in progress");
		const personal = readPersonalAccess(fresh);
		const isOther = fresh.stripeSubscriptionId && fresh.stripeSubscriptionId !== subscription.id;
		if (isOther && next.tier !== "paid" && personal && ["active", "trialing"].includes(personal.status)) return { skip: true, ignored: "another subscription of the reader's is active" };
		if (next.tier !== "paid" && personal?.kind === "lifetime" && isPaidContact({ tier: "paid", paidUntil: personal.until })) return { skip: true, ignored: "the reader paid for life" };
		return { guard: { paidPersonalLease: personalLease }, set: {
			paidPersonal: { kind: "stripe", status: next.status, tierId, until: next.paidUntil, interval: next.paidInterval, subscriptionId: subscription.id, observedAt },
			stripeSubscriptionId: subscription.id, subscriptionStatus: next.status,
			...(getCustomerId(subscription) && { stripeCustomerId: getCustomerId(subscription) }),
			...(metadata.offerId && { offerId: metadata.offerId }), ...(supporterName && { supporterName }),
		} };
	} });
	return result.ignored ? { ignored: result.ignored } : { contactId: String(contact._id), tier: result.contact.tier, tierId: result.contact.paidTierId ?? null };

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
	const tierId = readTierId(metadata, newsletter);
	const result = await updatePaidAccess({ account, newsletter, contactId: contact._id, notify: true, source: "stripe", change: fresh => {
		if (paymentIntentId && fresh.lifetimePaymentIntentId === paymentIntentId) return { skip: true };
		return { set: {
			paidPersonal: { kind: "lifetime", status: "active", tierId, until: LIFETIME_END, interval: "lifetime", observedAt: new Date() },
			...(paymentIntentId && { lifetimePaymentIntentId: paymentIntentId }),
			...(typeof session.customer === "string" && { stripeCustomerId: session.customer }),
			...(metadata.offerId && { offerId: metadata.offerId }), ...(readSupporterName(session) && { supporterName: readSupporterName(session) }),
		} };
	} });
	return { contactId: String(contact._id), tier: result.contact.tier, tierId: result.contact.paidTierId ?? tierId, ...(!result.changed && { duplicate: true }) };

}

// The latest state is read from Stripe rather than trusted from the event: events can arrive late or out of order, and
// the state they describe is one read away. email: a Checkout Session already knows it.
async function syncSubscriptionById({ account, subscriptionId, email, supporterName, event = null, invoice = null }) {
	if (typeof subscriptionId !== "string") return { ignored: "no subscription" };
	const existing = await Contact.findOne(scoped(account, { stripeSubscriptionId: subscriptionId })).select("_id").lean();
	const personalLease = existing ? randomUUID() : null;
	if (existing) await Contact.updateOne(scoped(account, { _id: existing._id }), { $set: { paidPersonalLease: personalLease } });
	const observedAt = new Date();
	const subscription = await stripeRequest(`/v1/subscriptions/${subscriptionId}`, { account: getChargeAccount(account) });
	return syncSubscription({ account, subscription, email, supporterName, event, invoice, observedAt, personalLease, leaseContactId: existing?._id });
}

// Reader-initiated billing reads claim the same lease before their version-pinned Stripe request. An older response
// cannot restore a personal source over a newer webhook, checkout or another reader billing operation.
export async function syncObservedPersonalSubscription({ account, contactId, subscription, lease, observedAt }) {
	const current = await Contact.findOne(scoped(account, { _id: contactId, paidPersonalLease: lease })).lean();
	if (!lease || !current) return { ignored: "a newer personal billing observation won" };
	return syncSubscription({ account, subscription, observedAt, personalLease: lease, leaseContactId: contactId });
}

// The name a founding member gave in Checkout's custom field for the supporters list.
function readSupporterName(session) {
	const field = session.custom_fields?.find((candidate) => candidate.key === "supportername");
	return String(field?.text?.value ?? "").replace(/[<>]/g, "").trim().slice(0, 60) || undefined;
}

export function syncPaidTierSession({ account, session, event = null }) {
	if (session.mode === "payment") return syncLifetimeSession({ account, session });
	const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
	return syncSubscriptionById({
		account,
		event,
		subscriptionId,
		email: normalizeEmail(session.customer_details?.email ?? session.customer_email ?? "") ?? undefined,
		supporterName: readSupporterName(session),
	});
}

function handleSubscription({ account, object, event }) {
	return syncSubscriptionById({ account, subscriptionId: object.id, event });
}

function handleInvoice({ account, object, event }) {
	const subscriptionId = object.subscription ?? object.parent?.subscription_details?.subscription;
	return syncSubscriptionById({ account, subscriptionId: typeof subscriptionId === "string" ? subscriptionId : subscriptionId?.id, event, invoice: object });
}

// A full refund of a lifetime payment ends that access, as a refunded product's download link stops.
async function handleLifetimeRefund({ account, object }) {
	const isFull = object.refunded === true || (object.amount > 0 && object.amount_refunded >= object.amount);
	const contact = typeof object.payment_intent === "string" ? await Contact.findOne(scoped(account, { lifetimePaymentIntentId: object.payment_intent })).lean() : null;
	if (!contact) return { ignored: "no lifetime reader for this charge" };
	if (!isFull) return { ignored: "a partial refund" };
	const newsletter = await Newsletter.findOne(scoped(account, { _id: contact.newsletterId })).lean();
	if (!newsletter) return { ignored: "unknown newsletter" };
	await updatePaidAccess({ account, newsletter, contactId: contact._id, notify: true, source: "stripe", change: fresh => {
		if (fresh.lifetimePaymentIntentId !== object.payment_intent) return { skip: true };
		const personal = readPersonalAccess(fresh);
		return { set: { paidPersonal: personal?.kind === "lifetime" ? { ...personal, status: "canceled" } : personal }, unset: { lifetimePaymentIntentId: 1 } };
	} });
	return { contactId: String(contact._id), refunded: true };
}

export const subscriptionHandlers = {
	"customer.subscription.created": handleSubscription,
	"customer.subscription.updated": handleSubscription,
	"customer.subscription.paused": handleSubscription,
	"customer.subscription.resumed": handleSubscription,
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
