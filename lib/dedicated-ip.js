import "server-only";
import { hasActiveSubscription, isPaidStatus } from "@/lib/account-state";
import { connectDb } from "@/lib/db";
import { getEmailProvider } from "@/lib/email-provider";
import { noteWaiting } from "@/lib/ip-assignment";
import { DEDICATED_IP_PLAN_IDS, INTERVALS, getAccountPlan, getPlan } from "@/lib/plans";
import { ADDON_METADATA, DEDICATED_IP_ADDON, cancelSubscriptionAtPeriodEnd } from "@/lib/polar";
import Account from "@/models/Account";

// The dedicated IP add-on: a Polar subscription of its own, next to the plan's, on Pro and above, at one price whatever the
// plan. It gives the account one of the inventory's IPs (the provider's setDedicatedIp, the same call as the admin's
// "Assign an IP") once it's paid, or marks it waiting when none is free and gives one the hour an admin adds one. It takes
// the IP back when the add-on ends or the plan drops below Pro, which also cancels it at the end of its period.

function toDate(value) {
	return value ? new Date(value) : null;
}

export function isDedicatedIpSubscription(subscription) {
	return subscription?.product?.metadata?.[ADDON_METADATA] === DEDICATED_IP_ADDON || subscription?.metadata?.addon === DEDICATED_IP_ADDON;
}

export function canHaveDedicatedIp(account) {
	return hasActiveSubscription(account) && DEDICATED_IP_PLAN_IDS.includes(getAccountPlan(account)?.id);
}

// Paid before it turns on: "active" is a paid period. Once on, a renewal Polar retries (past_due) doesn't turn it off.
export function wantsDedicatedIp(account) {
	const addon = account?.dedicatedIp;
	if (!addon?.polarSubscriptionId) return false;
	const isPaid = addon.status === "active" || (Boolean(addon.turnedOnAt) && isPaidStatus(addon.status));
	return isPaid && canHaveDedicatedIp(account);
}

// The add-on as Polar has it now. An older add-on subscription ending never touches the current one.
export async function applyDedicatedIpSubscription(account, subscription) {
	const current = account.dedicatedIp?.polarSubscriptionId;
	if (current && current !== subscription.id && !isPaidStatus(subscription.status)) return { ignored: "an older add-on subscription" };
	const metadata = subscription.product?.metadata ?? {};
	const interval = subscription.recurring_interval ?? metadata.interval;
	const cancelAt = isPaidStatus(subscription.status) && subscription.cancel_at_period_end ? (toDate(subscription.ends_at) ?? toDate(subscription.current_period_end)) : null;
	await Account.updateOne(
		{ _id: account._id },
		{
			$set: {
				"dedicatedIp.polarSubscriptionId": subscription.id,
				"dedicatedIp.status": subscription.status,
				"dedicatedIp.currentPeriodEnd": toDate(subscription.current_period_end),
				// A subscription on one of the per-plan products from before the single price still names its plan.
				...(getPlan(metadata.flockstack_plan) && { "dedicatedIp.plan": metadata.flockstack_plan }),
				...(INTERVALS.includes(interval) && { "dedicatedIp.interval": interval }),
				...(cancelAt && { "dedicatedIp.cancelAt": cancelAt }),
				...(!account.polarCustomerId && subscription.customer_id && { polarCustomerId: subscription.customer_id }),
			},
			...(!cancelAt && { $unset: { "dedicatedIp.cancelAt": 1 } }),
		}
	);
	const updated = await Account.findById(account._id).lean();
	return { addon: DEDICATED_IP_ADDON, status: subscription.status, ...(await followPlan(updated)) };
}

// After the plan changed, or the add-on did: below Pro, or without a plan, the add-on is canceled at the end of its
// period. Between Pro, Scale and Max nothing changes: it costs the same on all three. Then the IP follows.
export async function followPlan(account) {
	await connectDb();
	const addon = account?.dedicatedIp;
	if (!addon?.polarSubscriptionId || !isPaidStatus(addon.status)) return syncDedicatedIp(account);
	if (!canHaveDedicatedIp(account) && !addon.cancelAt) {
		const canceled = await cancelSubscriptionAtPeriodEnd(addon.polarSubscriptionId);
		const cancelAt = toDate(canceled?.ends_at) ?? toDate(canceled?.current_period_end) ?? addon.currentPeriodEnd ?? new Date();
		await Account.updateOne({ _id: account._id }, { $set: { "dedicatedIp.cancelAt": cancelAt } });
	}
	return syncDedicatedIp(await Account.findById(account._id).lean());
}

// The hourly cron, for what no Polar event announces: a free plan from an admin reaching its end date, or an add-on
// whose last sync failed.
export async function followDedicatedIps() {
	await connectDb();
	const accounts = await Account.find({ "dedicatedIp.polarSubscriptionId": { $exists: true }, "dedicatedIp.status": { $in: ["active", "trialing", "past_due"] } })
		.limit(500)
		.lean();
	let changed = 0;
	for (const account of accounts) {
		const needsCancel = !canHaveDedicatedIp(account) && !account.dedicatedIp.cancelAt;
		if (!needsCancel && wantsDedicatedIp(account) === Boolean(account.dedicatedIp.turnedOnAt)) continue;
		try {
			await followPlan(account);
			changed++;
		} catch (error) {
			console.error(`[billing] Couldn't bring account ${account._id}'s dedicated IP in line with its add-on:`, error.message);
		}
	}
	return changed;
}

// Turns the IP on or off to match the add-on. Only an IP the add-on turned on is turned off: one an admin gave by hand
// (the admin page) stays. Paid with no IP free, the add-on waits (dedicatedIp.waitingAt, the admin is alerted) and the
// hourly cron, or an admin adding an IP, gives it one. A failure throws, so Polar sends the event again.
export async function syncDedicatedIp(account) {
	const wanted = wantsDedicatedIp(account);
	const isOn = Boolean(account?.dedicatedIp?.turnedOnAt);
	const isWaiting = Boolean(account?.dedicatedIp?.waitingAt);
	if (wanted === isOn) {
		if (!wanted && isWaiting) await Account.updateOne({ _id: account._id }, { $unset: { "dedicatedIp.waitingAt": 1 } });
		return { dedicatedIp: isOn ? "on" : "off" };
	}
	const provider = getEmailProvider();
	if (!provider.setDedicatedIp) {
		await Account.updateOne({ _id: account._id }, { $set: { "dedicatedIp.error": `${provider.name} has no dedicated IPs here` } });
		return { dedicatedIp: "unavailable" };
	}
	let result;
	try {
		result = await provider.setDedicatedIp(account._id, wanted);
	} catch (error) {
		await Account.updateOne({ _id: account._id }, { $set: { "dedicatedIp.error": String(error?.message ?? error).slice(0, 300) } });
		throw error;
	}
	if (wanted && result?.status === "waiting") {
		if (!isWaiting) await Account.updateOne({ _id: account._id }, { $set: { "dedicatedIp.waitingAt": new Date() }, $unset: { "dedicatedIp.error": 1 } });
		await noteWaiting(account._id);
		return { dedicatedIp: "waiting" };
	}
	await Account.updateOne(
		{ _id: account._id },
		wanted
			? { $set: { "dedicatedIp.turnedOnAt": new Date() }, $unset: { "dedicatedIp.waitingAt": 1, "dedicatedIp.error": 1 } }
			: { $unset: { "dedicatedIp.turnedOnAt": 1, "dedicatedIp.waitingAt": 1, "dedicatedIp.error": 1 } }
	);
	console.info(`[billing] The dedicated IP add-on turned ${wanted ? "on" : "off"} the dedicated IP of account ${account._id}`);
	return { dedicatedIp: wanted ? "on" : "off" };
}
