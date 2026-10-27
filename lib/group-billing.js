import "server-only";
import { randomUUID } from "node:crypto";
import { scoped } from "@/lib/account-scope";
import { actionError } from "@/lib/actions/errors";
import { assertGroupChargeAccount, findGroup } from "@/lib/group-subscriptions";
import { readGroupFunding } from "@/lib/group-subscription-rules";
import { groupStripeRequest } from "@/lib/group-stripe";
import { updatePaidAccess } from "@/lib/paid-access";
import { getChargeAccount } from "@/lib/payments/connect";
import { captureSubscriptionFinancial, invoiceSubscriptionId } from "@/lib/subscription-revenue";
import { isObjectIdString, normalizeEmail } from "@/lib/validation";
import GroupSubscription from "@/models/GroupSubscription";
import Newsletter from "@/models/Newsletter";

const ref = value => typeof value === "string" ? value : value?.id;
const providerId = (value, prefix) => typeof value === "string" && new RegExp(`^${prefix}_[A-Za-z0-9_]{1,160}$`).test(value);

export function isGroupMetadata(account, group, metadata) {
	return metadata?.flockstack === "1" && metadata.kind === "group_subscription" && metadata.accountId === String(account._id) && metadata.newsletterId === String(group.newsletterId) && metadata.groupId === String(group._id) && metadata.tierId === group.tierId;
}

export async function reconcileGroupReaders(account, newsletter, group) {
	const ids = [...new Set((group.seats ?? []).filter(seat => seat.contactId).map(seat => String(seat.contactId)))];
	for (let start = 0; start < ids.length; start += 5) {
		const results = await Promise.allSettled(ids.slice(start, start + 5).map(contactId => updatePaidAccess({ account, newsletter, contactId, notify: true, change: () => ({ forceRevision: true }) })));
		const failed = results.find(result => result.status === "rejected" && result.reason?.code !== "not_found");
		if (failed) throw failed.reason;
	}
}

// The lease starts before provider reads. A late response cannot overwrite a newer refresh. Seat edits have their own
// revision and are never replaced by this billing patch; every access check also reads the current parent group.
export async function refreshGroupBilling({ account, groupId, event = null }) {
	let group = await findGroup(account, groupId);
	assertGroupChargeAccount(account, group);
	const newsletter = await Newsletter.findOne(scoped(account, { _id: group.newsletterId })).lean();
	if (!newsletter) throw actionError("not_found", "Newsletter not found");
	const lease = randomUUID();
	const claimed = await GroupSubscription.updateOne(scoped(account, { _id: group._id }), { $set: { billingLease: lease } });
	if (!claimed.matchedCount) throw actionError("not_found", "Group subscription not found");
	const request = (path, params) => groupStripeRequest(path, { account: getChargeAccount(account), params });
	let subscriptionId = group.stripeSubscriptionId;
	if (!subscriptionId) {
		if (!providerId(group.stripeSessionId, "cs")) return group;
		const session = await request(`/v1/checkout/sessions/${group.stripeSessionId}`);
		if (session.id !== group.stripeSessionId || !isGroupMetadata(account, group, session.metadata)) throw actionError("conflict", "This checkout belongs to another group");
		if (session.status === "expired") {
			const closed = await GroupSubscription.updateOne(scoped(account, { _id: group._id, billingLease: lease, status: "checkout" }), { $set: { status: "canceled", subscriptionStatus: "checkout_expired", capacity: 0, billingObservedAt: new Date() }, $inc: { revision: 1 } });
			if (!closed.matchedCount) throw actionError("conflict", "This group changed during its checkout refresh");
			return findGroup(account, group._id);
		}
		if (session.status !== "complete" || !providerId(ref(session.subscription), "sub")) return group;
		subscriptionId = ref(session.subscription);
	}
	if (!providerId(subscriptionId, "sub")) throw actionError("conflict", "This group's subscription reference is invalid");
	const observedAt = new Date();
	const subscription = await request(`/v1/subscriptions/${subscriptionId}`, { expand: ["latest_invoice"] });
	const customerId = ref(subscription?.customer);
	if (subscription?.id !== subscriptionId || !isGroupMetadata(account, group, subscription.metadata) || !providerId(customerId, "cus") || group.stripeCustomerId && customerId !== group.stripeCustomerId) throw actionError("conflict", "Stripe returned billing for another group");
	let invoice = subscription.latest_invoice;
	if (typeof invoice === "string" && providerId(invoice, "in")) invoice = await request(`/v1/invoices/${invoice}`);
	if (invoice && (invoiceSubscriptionId(invoice) !== subscriptionId || ref(invoice.customer) !== customerId)) invoice = null;
	let buyerEmail;
	if (!group.buyerVerifiedAt) {
		const customer = await request(`/v1/customers/${customerId}`);
		buyerEmail = customer?.id === customerId && !customer.deleted ? normalizeEmail(customer.email ?? "") : null;
		if (!buyerEmail) throw actionError("conflict", "The group's buyer address needs review in Stripe");
	}
	group = await GroupSubscription.findOne(scoped(account, { _id: group._id, billingLease: lease })).lean();
	if (!group) throw actionError("conflict", "A newer billing refresh is in progress. Try again.");
	if (group.stripeSubscriptionId && group.stripeSubscriptionId !== subscriptionId) throw actionError("conflict", "This group is bound to another subscription");
	const funding = readGroupFunding({ subscription, invoice, previous: group });
	const set = {
		stripeSubscriptionId: subscriptionId, stripeCustomerId: customerId,
		subscriptionStatus: funding.supported ? subscription.status : "unsupported",
		status: ["canceled", "incomplete_expired"].includes(subscription.status) ? "canceled" : "active",
		billingObservedAt: observedAt,
		...(buyerEmail && !group.buyerVerifiedAt && { buyerEmail, buyerVerifiedAt: new Date() }),
		...(funding.supported ? { capacity: funding.capacity, paidUntil: funding.paidUntil, providerPeriodEnd: funding.providerPeriodEnd, verifiedInvoiceId: funding.verifiedInvoiceId, billingProblem: null } : { capacity: 0, billingProblem: funding.reason }),
	};
	const written = await GroupSubscription.updateOne(scoped(account, { _id: group._id, billingLease: lease }), { $set: set, $inc: { revision: 1 } });
	if (!written.matchedCount) throw actionError("conflict", "A newer billing refresh is in progress. Try again.");
	const current = await findGroup(account, group._id);
	await reconcileGroupReaders(account, newsletter, current);
	await captureSubscriptionFinancial({ account, newsletter, subscription, event, invoice, observedAt });
	return current;
}

// The signed webhook's object chooses a local row; fulfillment still rereads its stored Checkout and current subscription.
export async function handleGroupPayment({ account, object, event }) {
	let group;
	if (object.object === "checkout.session") {
		if (object.metadata?.kind !== "group_subscription") return { ignored: "not a group checkout" };
		group = isObjectIdString(object.metadata.groupId ?? "") ? await GroupSubscription.findOne(scoped(account, { _id: object.metadata.groupId, stripeSessionId: object.id })).lean() : null;
	} else {
		const subscriptionId = object.object === "subscription" ? object.id : invoiceSubscriptionId(object);
		group = providerId(subscriptionId, "sub") ? await GroupSubscription.findOne(scoped(account, { stripeSubscriptionId: subscriptionId })).lean() : null;
		if (!group && object.metadata?.kind === "group_subscription" && isObjectIdString(object.metadata.groupId ?? "")) group = await GroupSubscription.findOne(scoped(account, { _id: object.metadata.groupId })).lean();
	}
	if (!group) return { ignored: "unknown group subscription" };
	const refreshed = await refreshGroupBilling({ account, groupId: group._id, event });
	if (object.object === "checkout.session" && refreshed.buyerVerifiedAt && !refreshed.buyerReceiptSentAt) await (await import("@/lib/group-seats")).sendGroupManagerLink({ account, groupId: group._id, initial: true });
	return { groupId: String(group._id), capacity: refreshed.capacity };
}

export async function findGroupAccountId(object) {
	const subscriptionId = object.object === "subscription" ? object.id : invoiceSubscriptionId(object);
	if (!providerId(subscriptionId, "sub")) return null;
	const group = await GroupSubscription.findOne({ stripeSubscriptionId: subscriptionId }).select("accountId").setOptions({ crossAccount: true }).lean();
	return group?.accountId ?? null;
}

export async function isLocalGroupSubscription(account, object) {
	if (object.metadata?.kind === "group_subscription") return true;
	const subscriptionId = object.object === "subscription" ? object.id : invoiceSubscriptionId(object);
	return providerId(subscriptionId, "sub") && Boolean(await GroupSubscription.exists(scoped(account, { stripeSubscriptionId: subscriptionId })));
}

const amount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const date = value => Number.isSafeInteger(value) && value > 0 && Number.isFinite(new Date(value * 1000).getTime()) ? new Date(value * 1000).toISOString() : null;
const stripeUrl = value => {
	try { const url = new URL(value); return url.protocol === "https:" && ["invoice.stripe.com", "pay.stripe.com"].includes(url.hostname) && !url.username && !url.password ? url.href : null; } catch { return null; }
};

export async function listGroupInvoices({ account, groupId, after }) {
	const group = await findGroup(account, groupId);
	assertGroupChargeAccount(account, group);
	if (!group.stripeCustomerId || !group.stripeSubscriptionId) return { invoices: [], hasMore: false, nextCursor: null };
	if (after && !providerId(after, "in")) throw actionError("validation_failed", "Invalid invoice cursor");
	const result = await groupStripeRequest("/v1/invoices", { account: getChargeAccount(account), params: { customer: group.stripeCustomerId, subscription: group.stripeSubscriptionId, limit: 25, ...(after && { starting_after: after }) } });
	if (!Array.isArray(result?.data) || result.data.some(invoice => invoiceSubscriptionId(invoice) !== group.stripeSubscriptionId || ref(invoice.customer) !== group.stripeCustomerId)) throw actionError("conflict", "Stripe returned invoices for another group");
	return { invoices: result.data.map(invoice => ({ id: invoice.id, number: typeof invoice.number === "string" ? invoice.number : null, status: typeof invoice.status === "string" ? invoice.status : null, currency: /^[a-z]{3}$/.test(invoice.currency ?? "") ? invoice.currency : null, totalMinor: amount(invoice.total), amountPaidMinor: amount(invoice.amount_paid), amountDueMinor: amount(invoice.amount_due), createdAt: date(invoice.created), paidAt: date(invoice.status_transitions?.paid_at), hostedUrl: stripeUrl(invoice.hosted_invoice_url), pdfUrl: stripeUrl(invoice.invoice_pdf) })), hasMore: result.has_more === true, nextCursor: result.has_more && result.data.length ? result.data.at(-1).id : null };
}

function safePortalConfiguration(configuration, account, group) {
	const features = configuration?.features;
	return configuration?.active === true && isGroupMetadata(account, group, configuration.metadata) && features?.invoice_history?.enabled === true && features.payment_method_update?.enabled === true && features.subscription_cancel?.enabled === true && features.subscription_cancel.mode === "at_period_end" && features.subscription_update?.enabled === false && features.customer_update?.enabled === false && configuration.login_page?.enabled === false;
}

// An explicit button creates this group-only portal. Never reuse or change the creator's default configuration.
export async function createGroupPortal({ account, groupId, returnUrl }) {
	const group = await findGroup(account, groupId);
	assertGroupChargeAccount(account, group);
	if (!group.stripeCustomerId || !group.stripeSubscriptionId) throw actionError("conflict", "This checkout hasn't created a billing account yet");
	let configuration;
	const stripeAccount = getChargeAccount(account);
	// A creator can add sales to a Stripe customer outside FlockStack. The general portal would expose those too.
	// Refuse a shared or incompletely scanned customer instead of handing a group manager unrelated billing.
	const subscriptions = await groupStripeRequest("/v1/subscriptions", { account: stripeAccount, params: { customer: group.stripeCustomerId, status: "all", limit: 100 } });
	if (subscriptions?.has_more || !Array.isArray(subscriptions?.data) || subscriptions.data.length !== 1 || subscriptions.data[0].id !== group.stripeSubscriptionId || !isGroupMetadata(account, group, subscriptions.data[0].metadata)) throw actionError("conflict", "This group's Stripe customer also has other or unverified subscriptions. Ask the creator to review billing.");
	const invoices = await groupStripeRequest("/v1/invoices", { account: stripeAccount, params: { customer: group.stripeCustomerId, limit: 100 } });
	if (invoices?.has_more || !Array.isArray(invoices?.data) || invoices.data.some(invoice => ref(invoice.customer) !== group.stripeCustomerId || invoiceSubscriptionId(invoice) !== group.stripeSubscriptionId)) throw actionError("conflict", "This group's Stripe customer has other invoices or too much history to verify here. Ask the creator to manage billing in Stripe.");
	if (group.portalConfigurationId) configuration = await groupStripeRequest(`/v1/billing_portal/configurations/${group.portalConfigurationId}`, { account: stripeAccount });
	else {
		configuration = await groupStripeRequest("/v1/billing_portal/configurations", { method: "POST", account: stripeAccount, idempotencyKey: `flockstack-group-portal-${group._id}`, params: {
			business_profile: { headline: "Manage your group subscription" },
			metadata: { flockstack: "1", kind: "group_subscription", accountId: String(account._id), newsletterId: String(group.newsletterId), groupId: String(group._id), tierId: group.tierId },
			login_page: { enabled: false },
			features: { invoice_history: { enabled: true }, payment_method_update: { enabled: true }, subscription_cancel: { enabled: true, mode: "at_period_end" }, subscription_update: { enabled: false }, customer_update: { enabled: false } },
		} });
		if (!safePortalConfiguration(configuration, account, group)) throw actionError("conflict", "The group billing configuration needs review");
		const stored = await GroupSubscription.updateOne(scoped(account, { _id: group._id, stripeCustomerId: group.stripeCustomerId }), { $set: { portalConfigurationId: configuration.id } });
		if (!stored.matchedCount) throw actionError("conflict", "This group changed. Refresh before managing billing.");
	}
	if (!safePortalConfiguration(configuration, account, group)) throw actionError("conflict", "The group billing configuration changed in Stripe. Ask the creator to review it.");
	const session = await groupStripeRequest("/v1/billing_portal/sessions", { method: "POST", account: stripeAccount, params: { customer: group.stripeCustomerId, configuration: configuration.id, return_url: returnUrl } });
	return { url: session.url };
}
