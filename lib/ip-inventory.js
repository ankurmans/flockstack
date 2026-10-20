import "server-only";
import { sendAlert } from "@/lib/alerts";
import { getEmailProviderId } from "@/lib/config";
import { connectDb } from "@/lib/db";
import { DEDICATED_IP_AWS_MONTHLY_COST } from "@/lib/plans";
import { createDedicatedIpPool, getDedicatedIp, listDedicatedIps, moveDedicatedIpToPool } from "@/lib/ses";
import Account from "@/models/Account";
import DedicatedIp from "@/models/DedicatedIp";

// The standard dedicated IPs the AWS account has leased. AWS has no API to lease or relinquish one: it is a Service Quotas
// support case ("Desired Dedicated IP", docs.aws.amazon.com/ses/latest/dg/dedicated-ip-case.html), granted by AWS in
// hours or days. So the owner leases a few ahead of time, an admin adds them here (or imports them from AWS), and an
// account that pays for the add-on is given one of them in seconds (lib/ip-assignment.js). Each one costs
// DEDICATED_IP_AWS_MONTHLY_COST a month from the day it's leased, used or not.

// Where an IP waits until it is given to an account. It must not wait in SES's default pool: that is where a configuration
// set without a pool sends from, so every account on shared IPs would send through it.
export const PARKING_POOL = "flockstack-parking";
// SES allows 50 pools in all, inclusive of this one and every account's own (docs.aws.amazon.com/ses/latest/dg/quotas.html,
// not adjustable), so that many accounts at most can have a dedicated IP in one AWS account and region.
export const MAX_POOLS = 50;

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

export function isValidIp(value) {
	return IPV4.test(String(value ?? "").trim());
}

export function getIdleMonthlyCost(available) {
	return Math.round(available * DEDICATED_IP_AWS_MONTHLY_COST * 100) / 100;
}

async function park(ip) {
	await createDedicatedIpPool(PARKING_POOL);
	await moveDedicatedIpToPool(ip, PARKING_POOL);
}

// Adds an IP the AWS account leased: checks that AWS lists it, moves it out of the default pool into the parking one,
// and makes it available. A retired IP comes back. Returns { ip } or { error }.
export async function addIp({ ip, notes = "", by = "" }) {
	const address = String(ip ?? "").trim();
	if (!isValidIp(address)) return { error: "That isn't an IPv4 address" };
	await connectDb();
	const existing = await DedicatedIp.findOne({ ip: address }).lean();
	if (existing && existing.state !== "retired") return { error: `${address} is in the inventory already (${existing.state})` };
	const leased = await getDedicatedIp(address);
	if (!leased) return { error: `AWS doesn't list ${address}: lease it first (README, Dedicated IPs), then add it here` };
	await park(address);
	const note = [notes.trim(), by && `Added by ${by}`].filter(Boolean).join(". ");
	if (existing) {
		await DedicatedIp.updateOne(
			{ _id: existing._id },
			{ $set: { state: "available", poolName: PARKING_POOL, notes: note || existing.notes }, $unset: { retiredAt: 1, accountId: 1, assignedAt: 1 } }
		);
	} else {
		await DedicatedIp.create({ ip: address, state: "available", poolName: PARKING_POOL, leasedAt: new Date(), ...(note && { notes: note }) });
	}
	console.info(`[ip] ${address} is in the inventory${by ? `, added by ${by}` : ""}`);
	return { ip: address };
}

// Every IP AWS lists that the inventory doesn't have goes in; an available IP that AWS no longer lists (relinquished) is retired.
// An IP that is in use but gone from AWS is only reported: its account's mail is about to fail.
export async function importIpsFromAws({ by = "" } = {}) {
	await connectDb();
	const [leased, known] = await Promise.all([listDedicatedIps(), DedicatedIp.find({}).lean()]);
	const leasedIps = new Set(leased.map(({ ip }) => ip));
	const knownByIp = new Map(known.map((doc) => [doc.ip, doc]));
	const added = [];
	const failed = [];
	for (const { ip } of leased) {
		if (knownByIp.get(ip) && knownByIp.get(ip).state !== "retired") continue;
		const result = await addIp({ ip, notes: "Imported from AWS", by });
		if (result.error) failed.push(`${ip}: ${result.error}`);
		else added.push(ip);
	}
	const retired = [];
	const missing = [];
	for (const doc of known) {
		if (leasedIps.has(doc.ip) || doc.state === "retired") continue;
		if (doc.state === "available") {
			await DedicatedIp.updateOne({ _id: doc._id }, { $set: { state: "retired", retiredAt: new Date(), notes: "AWS no longer lists it (relinquished)" } });
			retired.push(doc.ip);
		} else missing.push(doc.ip);
	}
	return { added, retired, missing, failed };
}

// Takes an available IP out of use. Relinquishing it at AWS is a support case, and only that stops its monthly cost.
export async function retireIp(ip) {
	await connectDb();
	const doc = await DedicatedIp.findOne({ ip }).lean();
	if (!doc) return { error: "That IP isn't in the inventory" };
	if (doc.state === "retired") return { ip };
	if (doc.state !== "available") return { error: `${ip} is in use by account ${doc.accountId}: take it away from the account first` };
	const { modifiedCount } = await DedicatedIp.updateOne({ _id: doc._id, state: "available" }, { $set: { state: "retired", retiredAt: new Date() } });
	return modifiedCount ? { ip } : { error: `${ip} was just given to an account` };
}

// The next IP for an account, claimed so two accounts never get the same one: an IP never used before first, then the one
// returned longest ago. Null when none is free.
export async function claimAvailableIp(accountId) {
	await connectDb();
	const claimed = await DedicatedIp.findOneAndUpdate(
		{ state: "available" },
		{ $set: { state: "warming", accountId, assignedAt: new Date() } },
		{ returnDocument: "after" }
	)
		.sort({ releasedAt: 1, leasedAt: 1 })
		.lean();
	return claimed ?? null;
}

export function findIpOf(accountId) {
	return DedicatedIp.findOne({ accountId, state: { $in: ["warming", "assigned"] } }).lean();
}

// Accounts that paid for the add-on and are waiting for an IP; and the ones that paid for it at all.
export async function countDemand() {
	await connectDb();
	const [waiting, purchases] = await Promise.all([
		Account.countDocuments({
			"dedicatedIp.waitingAt": { $exists: true },
			"dedicatedIp.status": { $in: ["active", "trialing", "past_due"] },
			"ses.dedicatedIpAddress": { $exists: false },
		}),
		Account.countDocuments({ "dedicatedIp.polarSubscriptionId": { $exists: true }, "dedicatedIp.status": { $in: ["active", "trialing", "past_due"] } }),
	]);
	return { waiting, purchases };
}

// For the admin page.
export async function getInventory() {
	await connectDb();
	const [ips, demand] = await Promise.all([DedicatedIp.find({}).sort({ ip: 1 }).lean(), countDemand()]);
	const accountIds = ips.map(({ accountId }) => accountId).filter(Boolean);
	const accounts = accountIds.length > 0 ? await Account.find({ _id: { $in: accountIds } }).select({ ses: 1 }).lean() : [];
	const warmups = new Map(accounts.map((account) => [String(account._id), account.ses?.ipWarmup ?? null]));
	const count = (state) => ips.filter((doc) => doc.state === state).length;
	const available = count("available");
	return {
		ips: ips.map((doc) => ({ ...doc, warmup: doc.accountId ? (warmups.get(String(doc.accountId)) ?? null) : null })),
		counts: { available, warming: count("warming"), assigned: count("assigned"), retired: count("retired") },
		idleMonthlyCost: getIdleMonthlyCost(available),
		monthlyCost: getIdleMonthlyCost(ips.length - count("retired")),
		...demand,
	};
}

// The alert: no IP is free and the next buyer, or one already waiting, would find none. Telegram too (lib/alert-rules.js).
// Quiet while one is free, and once a day while it isn't.
export async function checkInventoryLevel() {
	if (getEmailProviderId() !== "ses") return { skipped: "only SES has dedicated IPs here" };
	await connectDb();
	const [available, demand] = await Promise.all([DedicatedIp.countDocuments({ state: "available" }), countDemand()]);
	const isShort = available < 1 && (demand.waiting > 0 || demand.purchases > 0);
	if (isShort) {
		await sendAlert({
			accountId: null,
			key: "ip-inventory:empty",
			title: demand.waiting > 0 ? "A dedicated IP buyer is waiting for an IP" : "No spare dedicated IP",
			detail: `${demand.waiting} paid add-on${demand.waiting === 1 ? " is" : "s are"} waiting for an IP, ${demand.purchases} account${demand.purchases === 1 ? " has" : "s have"} bought the add-on, and the inventory has none free.`,
			action: "Request more dedicated IPs in the AWS Support Center (Service Quotas, Amazon SES, Desired Dedicated IP), then add them on the admin page. Customers are told to expect their IP within 2 business days.",
			path: "/admin",
			cooldownMinutes: 24 * 60,
		});
	}
	return { available, ...demand, isShort };
}
