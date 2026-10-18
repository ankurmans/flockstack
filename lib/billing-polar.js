import "server-only";
import { isPaidStatus } from "@/lib/account-state";
import { applyAccessChange } from "@/lib/billing";
import { connectDb } from "@/lib/db";
import { INTERVALS, getPlan, hasActiveFreePlan, isOnFreePlan } from "@/lib/plans";
import { getSubscription, listSubscriptions } from "@/lib/polar";
import { startFreePlanUsage, startUsagePeriod } from "@/lib/usage-period";
import { isObjectIdString } from "@/lib/validation";
import Account from "@/models/Account";

function toDate(value) {
	return value ? new Date(value) : null;
}

// The account our checkout names, as external customer id and in the metadata, else the Polar ids already stored.
async function findAccountFor(subscription) {
	const claimed = [subscription.metadata?.accountId, subscription.customer?.external_id].filter(isObjectIdString);
	if (new Set(claimed).size > 1) return null;
	if (claimed[0]) {
		const account = await Account.findById(claimed[0]).lean();
		if (account) return account;
	}
	const bySubscription = await Account.findOne({ polarSubscriptionId: subscription.id }).lean();
	if (bySubscription) return bySubscription;
	return subscription.customer_id ? Account.findOne({ polarCustomerId: subscription.customer_id }).lean() : null;
}

function readPlan(subscription) {
	const metadata = subscription.product?.metadata ?? {};
	const interval = subscription.recurring_interval ?? metadata.interval;
	return getPlan(metadata.flockstack_plan) && INTERVALS.includes(interval) ? { plan: metadata.flockstack_plan, interval } : null;
}

// Mirrors a subscription, as Polar has it now, on its account. An older subscription ending never cancels the current one.
export async function applyPolarSubscription(account, subscription) {
	const isCurrent = !account.polarSubscriptionId || account.polarSubscriptionId === subscription.id;
	const grantsAccess = isPaidStatus(subscription.status);
	if (!isCurrent && !grantsAccess) return { ignored: "an older subscription" };

	const price = readPlan(subscription);
	if (!price) console.error(`[billing] ${subscription.id} has a product without our plan metadata: ${subscription.product?.id}`);
	const periodStart = toDate(subscription.current_period_start);
	const periodEnd = toDate(subscription.current_period_end);
	const cancelAt = grantsAccess && subscription.cancel_at_period_end ? (toDate(subscription.ends_at) ?? periodEnd) : null;
	// A first plan, a new one after a canceled one, or one after a free plan, which pays nothing: the month starts now.
	// Renewals wait for their paid order.
	const paidThrough = account.usage?.paidThrough;
	const startsUsage = grantsAccess && periodStart && periodEnd && (!paidThrough || paidThrough < periodStart);
	// A paid plan ending hands over to a free plan still running, with the free plan's months.
	const startsFreeUsage = !grantsAccess && isPaidStatus(account.subscriptionStatus) && hasActiveFreePlan(account);

	await Account.updateOne(
		{ _id: account._id },
		{
			$set: {
				polarCustomerId: subscription.customer_id ?? subscription.customer?.id,
				polarSubscriptionId: subscription.id,
				subscriptionStatus: subscription.status,
				currentPeriodStart: periodStart,
				currentPeriodEnd: periodEnd,
				...(cancelAt && { cancelAt }),
				...(price && { plan: price.plan, interval: price.interval }),
				...(startsUsage && { usage: startUsagePeriod({ start: periodStart, end: periodEnd }) }),
				...(startsFreeUsage && { usage: startFreePlanUsage(account.comp.grantedAt) }),
			},
			...(!cancelAt && { $unset: { cancelAt: 1 } }),
		}
	);
	await applyAccessChange(account, { ...account, subscriptionStatus: subscription.status });
	return { updated: true, status: subscription.status };
}

// Events can arrive out of order, so the subscription is read fresh from Polar every time.
async function handleSubscriptionChange({ id }) {
	const subscription = await getSubscription(id);
	const account = await findAccountFor(subscription);
	if (!account) {
		console.error(`[billing] Polar subscription ${subscription.id} has no account`);
		return { ignored: "no account" };
	}
	return applyPolarSubscription(account, subscription);
}

// A paid renewal starts a new period, with the email count at zero. The same order delivered twice, or a mid-period
// plan change, pays no further and changes nothing.
async function handleOrderPaid(order) {
	const subscriptionId = order.subscription_id ?? order.subscription?.id;
	if (!subscriptionId) return { ignored: "not a subscription order" };
	const subscription = await getSubscription(subscriptionId);
	const account = await findAccountFor(subscription);
	if (!account) return { ignored: "no account" };
	if (account.polarSubscriptionId && account.polarSubscriptionId !== subscription.id) return { ignored: "an older subscription" };
	// The free plan's months count until a subscription is on again, which starts its own month.
	if (isOnFreePlan(account)) return { ignored: "on a free plan" };

	// Backs up a lost subscription event: the order is paid, so the subscription is current.
	const applied = await applyPolarSubscription(account, subscription);
	if (order.billing_reason !== "subscription_cycle" || !subscription.current_period_end) return { ...applied, reset: false };
	const usage = startUsagePeriod({ start: toDate(subscription.current_period_start), end: toDate(subscription.current_period_end) });
	const { modifiedCount } = await Account.updateOne(
		{ _id: account._id, $or: [{ "usage.paidThrough": null }, { "usage.paidThrough": { $lt: usage.paidThrough } }] },
		{ $set: { usage } }
	);
	return { ...applied, reset: modifiedCount > 0 };
}

const SUBSCRIPTION_EVENTS = new Set([
	"subscription.created",
	"subscription.active",
	"subscription.updated",
	"subscription.canceled",
	"subscription.uncanceled",
	"subscription.past_due",
	"subscription.revoked",
]);

export async function handlePolarEvent(event) {
	await connectDb();
	if (SUBSCRIPTION_EVENTS.has(event.type)) return handleSubscriptionChange(event.data);
	if (event.type === "order.paid") return handleOrderPaid(event.data);
	return { ignored: event.type };
}

// Coming back from Checkout: the plan is on before the webhook arrives, so the dashboard opens right away. The account is
// the signed-in one, and its subscriptions are the ones Polar lists for it as external customer.
export async function syncPolarCheckout({ account }) {
	await connectDb();
	const subscriptions = await listSubscriptions(account._id);
	const subscription = subscriptions.find(({ status }) => isPaidStatus(status));
	if (!subscription) return { ignored: "no paid subscription yet" };
	return applyPolarSubscription(account, subscription);
}
