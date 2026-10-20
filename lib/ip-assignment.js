import "server-only";
import { findOwnerEmail } from "@/lib/accounts";
import { sendAlert } from "@/lib/alerts";
import { connectDb } from "@/lib/db";
import { PARKING_POOL, checkInventoryLevel, claimAvailableIp, findIpOf } from "@/lib/ip-inventory";
import { IP_WARMUP, getDedicatedConfigurationSetName, getShareForDay } from "@/lib/ip-warmup-rules";
import { canSendPlatformEmail, sendPlatformEmail } from "@/lib/platform-email";
import {
	associateTenantResources,
	createConfigurationSet,
	createDedicatedIpPool,
	deleteDedicatedIpPool,
	getDedicatedIp,
	moveDedicatedIpToPool,
	setConfigurationSetPool,
	setDedicatedIpWarmupPercentage,
} from "@/lib/ses";
import Account from "@/models/Account";
import DedicatedIp from "@/models/DedicatedIp";

// Giving an account one of the inventory's IPs, and taking it back (lib/ip-inventory.js). The account gets a pool of its own
// and a second configuration set pointed at it, next to its shared one; the share of its email that goes through the
// second one is the warm-up (lib/ip-warmup-rules.js). Every step is safe to repeat, so a failed attempt is finished by the
// next one, and mail only starts to use the IP at the last step, once everything at AWS is in place.

export function getPoolName(accountId) {
	return `mc-ip-${accountId}`;
}

// A resource that's gone already is as good as released.
async function ignoreNotFound(promise) {
	try {
		await promise;
	} catch (error) {
		if (error?.name !== "NotFoundException") throw error;
	}
}

async function emailOwner(accountId, subject, text) {
	try {
		if (!canSendPlatformEmail()) return;
		const to = await findOwnerEmail(accountId);
		if (to) await sendPlatformEmail({ to, subject, text });
	} catch (error) {
		console.error(`[ip] Couldn't email the owner of account ${accountId}:`, error.message);
	}
}

// A managed pool, from before standard IPs, is billed $15 a month by AWS whether it sends or not: it's deleted, and the
// account sends from shared IPs until it's given a standard one.
export async function removeManagedPool(accountId, tenant) {
	await connectDb();
	const account = await Account.findById(accountId).select({ ses: 1 }).lean();
	const pool = account?.ses?.dedicatedPool;
	if (!pool || account.ses.dedicatedIpAddress) return false;
	await ignoreNotFound(setConfigurationSetPool(tenant?.configurationSet ?? account.ses.configurationSet, null));
	await deleteDedicatedIpPool(pool);
	await Account.updateOne(
		{ _id: account._id },
		{ $unset: { "ses.dedicatedPool": 1, "ses.dedicatedPoolAt": 1, "dedicatedIp.turnedOnAt": 1 } }
	);
	console.info(`[ip] The managed pool ${pool} of account ${accountId} was deleted`);
	return true;
}

// Accounts that still have a managed pool: the admin toggle made them before standard IPs, and no customer bought one.
export async function findManagedPoolAccounts() {
	await connectDb();
	return Account.find({ "ses.dedicatedPool": { $exists: true }, "ses.dedicatedIpAddress": { $exists: false } })
		.select({ ses: 1 })
		.limit(200)
		.lean();
}

// Deletes every managed pool and its account's pointer to it, so none is left billing $15 a month. An account whose
// add-on is paid is given a standard IP from the inventory next (the hourly cron, or the admin page's next step).
export async function convertManagedPools() {
	await connectDb();
	const accounts = await findManagedPoolAccounts();
	const failed = [];
	let converted = 0;
	for (const account of accounts) {
		try {
			if (await removeManagedPool(account._id, account.ses)) converted++;
		} catch (error) {
			failed.push(`${account._id}: ${error.message}`);
		}
	}
	return { converted, failed };
}

// tenant: the account's SES tenant (tenantName, configurationSet). Returns false for an account that isn't there;
// { status: "assigned", ip } when the account sends through its IP now (a warm-up starts), { status: "already", ip } when it
// did, and { status: "waiting" } when no IP is free.
export async function assignDedicatedIp(accountId, tenant) {
	await connectDb();
	let account = await Account.findById(accountId).select({ ses: 1 }).lean();
	if (!account) return false;
	if (account.ses?.dedicatedPool && !account.ses.dedicatedIpAddress) {
		await removeManagedPool(accountId, tenant);
		account = await Account.findById(accountId).select({ ses: 1 }).lean();
	}

	const { ses } = account;
	if (ses?.dedicatedIpAddress && ses.dedicatedConfigurationSet && ses.ipWarmup?.startedAt) {
		return { status: "already", ip: ses.dedicatedIpAddress };
	}

	// An IP this account already holds (a failed attempt claimed it) comes before a new one. One AWS no longer lists is retired.
	let doc;
	for (let attempt = 0; attempt < 5 && !doc; attempt++) {
		const candidate = (await findIpOf(accountId)) ?? (await claimAvailableIp(accountId));
		if (!candidate) break;
		const leased = await getDedicatedIp(candidate.ip);
		if (leased) {
			doc = candidate;
			if (leased.warmupStatus !== "DONE") await setDedicatedIpWarmupPercentage(candidate.ip, 100);
		} else {
			await DedicatedIp.updateOne(
				{ _id: candidate._id },
				{ $set: { state: "retired", retiredAt: new Date(), notes: "AWS no longer lists it (relinquished)" }, $unset: { accountId: 1, assignedAt: 1 } }
			);
			console.error(`[ip] ${candidate.ip} is in the inventory but AWS doesn't list it: retired`);
		}
	}
	if (!doc) return { status: "waiting" };

	const pool = getPoolName(accountId);
	const dedicatedSet = getDedicatedConfigurationSetName(tenant.configurationSet);
	await createDedicatedIpPool(pool);
	await moveDedicatedIpToPool(doc.ip, pool);
	await createConfigurationSet(dedicatedSet);
	await associateTenantResources(tenant.tenantName, { configurationSets: [dedicatedSet] });
	await setConfigurationSetPool(dedicatedSet, pool);

	const now = new Date();
	await DedicatedIp.updateOne({ _id: doc._id }, { $set: { poolName: pool } });
	await Account.updateOne(
		{ _id: accountId },
		{
			$set: {
				"ses.dedicatedPool": pool,
				"ses.dedicatedPoolAt": now,
				"ses.dedicatedIpAddress": doc.ip,
				"ses.dedicatedConfigurationSet": dedicatedSet,
				"ses.ipWarmup": { startedAt: now, day: 1, share: getShareForDay(1), advancedAt: now, holds: 0 },
			},
		}
	);
	console.info(`[ip] ${doc.ip} is in ${pool}: account ${accountId} starts its warm-up`);
	await emailOwner(
		accountId,
		"Your dedicated IP is warming up",
		`Your dedicated sending IP is set up and warming up. Over about ${IP_WARMUP.days} days a growing share of your email goes through it, from ${getShareForDay(1)}% on the first day to all of it, and the rest keeps going through shared IPs, so nothing about your sending changes meanwhile. The ramp pauses for a day when bounces or complaints rise or you send very little. The billing page shows where it is.`
	);
	await checkInventoryLevel();
	return { status: "assigned", ip: doc.ip };
}

// The admin or the add-on asked for an IP and none was free: a paid add-on waits for one and turns on once one is added.
export async function noteWaiting(accountId) {
	await sendAlert({
		accountId: null,
		key: `ip-inventory:waiting:${accountId}`,
		title: "A dedicated IP buyer is waiting for an IP",
		detail: `Account ${accountId} paid for the dedicated IP add-on and the inventory has no free IP. Its billing page says the IP is being prepared, usually within 2 business days.`,
		action: "Request a dedicated IP in the AWS Support Center (Service Quotas, Amazon SES, Desired Dedicated IP), then add it on the admin page: the account gets it by itself.",
		path: "/admin",
		cooldownMinutes: 24 * 60,
	});
}

// Takes the IP back: the account sends from shared IPs first, then the IP leaves its pool and goes back to the inventory,
// available again with a note, and the pool is deleted (SES allows 50 in all). A managed pool from before is deleted.
export async function releaseDedicatedIp(accountId, tenant) {
	await connectDb();
	const account = await Account.findById(accountId).select({ ses: 1 }).lean();
	if (!account) return false;
	const doc = await findIpOf(accountId);
	const ses = account.ses ?? {};
	if (ses.dedicatedPool && !ses.dedicatedIpAddress) return (await removeManagedPool(accountId, tenant)) ? { status: "released" } : { status: "none" };
	const ip = ses.dedicatedIpAddress ?? doc?.ip;
	if (!ip) return { status: "none" };
	const configurationSet = tenant?.configurationSet ?? ses.configurationSet;

	// Mail stops choosing the IP's set before anything at AWS moves. A batch that already chose it falls back to shared IPs
	// (lib/email-provider/ses.js).
	await Account.updateOne({ _id: accountId }, { $unset: { "ses.ipWarmup": 1, "ses.dedicatedConfigurationSet": 1 } });
	if (configurationSet) await ignoreNotFound(setConfigurationSetPool(getDedicatedConfigurationSetName(configurationSet), null));
	let isGone = false;
	try {
		await moveDedicatedIpToPool(ip, PARKING_POOL);
	} catch (error) {
		if (error?.name !== "NotFoundException") throw error;
		isGone = true;
	}
	await deleteDedicatedIpPool(ses.dedicatedPool ?? getPoolName(accountId));

	const now = new Date();
	if (doc) {
		const note = isGone
			? "AWS no longer lists it (relinquished)"
			: `Returned by account ${accountId} on ${now.toISOString().slice(0, 10)}. It carries that account's sending history: check its reputation before giving it to someone else.`;
		await DedicatedIp.updateOne(
			{ _id: doc._id },
			{
				$set: { state: isGone ? "retired" : "available", poolName: PARKING_POOL, lastAccountId: accountId, releasedAt: now, notes: note, ...(isGone && { retiredAt: now }) },
				$unset: { accountId: 1, assignedAt: 1 },
			}
		);
	}
	await Account.updateOne({ _id: accountId }, { $unset: { "ses.dedicatedPool": 1, "ses.dedicatedPoolAt": 1, "ses.dedicatedIpAddress": 1 } });
	console.info(`[ip] ${ip} came back from account ${accountId}${isGone ? " (AWS no longer lists it)" : ""}`);
	return { status: "released", ip };
}
