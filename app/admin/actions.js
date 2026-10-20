"use server";

import { isValidObjectId } from "@/lib/docdb";
import { revalidatePath } from "next/cache";
import { blockAccount, unblockAccount } from "@/lib/account-blocks";
import { setAudioLimitOverride, setLimitOverrides, setSendSpread } from "@/lib/accounts";
import { requireAdmin } from "@/lib/auth";
import { grantFreePlan, revokeFreePlan } from "@/lib/billing";
import { isCloud } from "@/lib/config";
import { deleteCustomRequest, updateCustomRequest } from "@/lib/custom-requests";
import { getGlobalSuppression, removeGlobalSuppression } from "@/lib/global-suppressions";
import { followDedicatedIps } from "@/lib/dedicated-ip";
import { getEmailProvider } from "@/lib/email-provider";
import { convertManagedPools } from "@/lib/ip-assignment";
import { addIp, importIpsFromAws, retireIp } from "@/lib/ip-inventory";
import { getPlan } from "@/lib/plans";
import { normalizeEmail } from "@/lib/validation";

const MAX_REASON_LENGTH = 200;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Empty means the plan's number; anything else must be a whole number.
function readLimit(value) {
	const text = String(value ?? "")
		.replaceAll(",", "")
		.trim();
	if (!text) return undefined;
	const number = Number(text);
	return Number.isInteger(number) && number >= 0 ? number : Number.NaN;
}

// A day from the date field: the plan ends as that day starts, at midnight UTC. Empty means no end.
function readEndDate(value) {
	const text = String(value ?? "").trim();
	if (!text) return null;
	return DATE_PATTERN.test(text) ? new Date(`${text}T00:00:00Z`) : new Date(Number.NaN);
}

// reason: what the account's owner reads on their dashboard.
export async function blockAccountAction(accountId, reason) {
	const admin = await requireAdmin();
	if (!isValidObjectId(accountId)) return { error: "Account not found" };
	const text = String(reason ?? "").trim().slice(0, MAX_REASON_LENGTH);
	// The terms promise the owner a reason with every block.
	if (!text) return { error: "Give a reason: the account's owner reads it" };
	const isBlocked = await blockAccount(accountId, { reason: text, by: "admin", detail: `Blocked by ${admin.email}` });
	console.info(`[admin] ${admin.email} blocked account ${accountId}`);
	revalidatePath("/admin");
	return isBlocked ? { ok: true } : { error: "Already blocked" };
}

// The only way a block ends. Its campaigns stay paused until their owner resumes them.
export async function unblockAccountAction(accountId) {
	const admin = await requireAdmin();
	if (!isValidObjectId(accountId)) return { error: "Account not found" };
	try {
		if (!(await unblockAccount(accountId))) return { error: "Not blocked" };
	} catch (error) {
		console.error(`[admin] The provider didn't resume account ${accountId}:`, error);
		return { error: `Still blocked, the tenant wasn't resumed: ${error.message}` };
	}
	console.info(`[admin] ${admin.email} unblocked account ${accountId}`);
	revalidatePath("/admin");
	return { ok: true };
}

export async function setSpread(accountId, isOn) {
	const admin = await requireAdmin();
	if (!isValidObjectId(accountId)) return { error: "Account not found" };
	if (!(await setSendSpread(accountId, isOn === true))) return { error: "Account not found" };
	console.info(`[admin] ${admin.email} turned ${isOn === true ? "on" : "off"} the warm-up for account ${accountId}`);
	revalidatePath("/admin");
	return { ok: true };
}

// Shared IPs are the default. "Assign an IP" gives the account one of the leased IPs in the inventory, for an account that
// pays for it or a test; it costs the lease whether the account sends or not. The account's warm-up starts at once.
export async function setDedicatedIp(accountId, isOn) {
	const admin = await requireAdmin();
	if (!isValidObjectId(accountId)) return { error: "Account not found" };
	const provider = getEmailProvider();
	if (!provider.setDedicatedIp) return { error: `${provider.name} has no dedicated IPs here` };
	let result;
	try {
		result = await provider.setDedicatedIp(accountId, isOn === true);
	} catch (error) {
		console.error(`[admin] ${provider.name} didn't ${isOn ? "give" : "take away"} the dedicated IP of account ${accountId}:`, error);
		return { error: error.message };
	}
	if (!result) return { error: "Account not found" };
	if (result.status === "waiting") return { error: "No IP is free in the inventory. Lease one in AWS and add it under Dedicated IPs below, then try again" };
	console.info(`[admin] ${admin.email} ${isOn === true ? "gave" : "took away"} the dedicated IP of account ${accountId}`);
	revalidatePath("/admin");
	return { ok: true, ip: result.ip ?? null };
}

// The inventory: IPs the AWS account leased, which an account's add-on or an admin gives out (lib/ip-inventory.js).
// An account whose add-on was paid with none free gets the new IP at once.
export async function addIpAction(ip, notes = "") {
	const admin = await requireAdmin();
	let result;
	try {
		result = await addIp({ ip, notes: String(notes).slice(0, 300), by: admin.email });
	} catch (error) {
		console.error(`[admin] Couldn't add the IP ${ip}:`, error);
		return { error: error.message };
	}
	if (result.error) return result;
	const assigned = await followDedicatedIps();
	revalidatePath("/admin");
	return { ok: true, ip: result.ip, assigned };
}

export async function importIpsAction() {
	const admin = await requireAdmin();
	let result;
	try {
		result = await importIpsFromAws({ by: admin.email });
	} catch (error) {
		console.error("[admin] Couldn't import the IPs from AWS:", error);
		return { error: error.message };
	}
	const assigned = await followDedicatedIps();
	revalidatePath("/admin");
	return { ok: true, ...result, assigned };
}

export async function retireIpAction(ip) {
	await requireAdmin();
	const result = await retireIp(String(ip));
	if (result.error) return result;
	revalidatePath("/admin");
	return { ok: true, ip: result.ip };
}

// Accounts that still have a managed pool from before standard IPs: AWS bills $15 a month for it whether it sends or not.
export async function convertManagedPoolsAction() {
	const admin = await requireAdmin();
	let result;
	try {
		result = await convertManagedPools();
	} catch (error) {
		console.error("[admin] Couldn't delete the managed pools:", error);
		return { error: error.message };
	}
	console.info(`[admin] ${admin.email} deleted ${result.converted} managed pool(s)`);
	const assigned = await followDedicatedIps();
	revalidatePath("/admin");
	return { ok: true, ...result, assigned };
}

export async function saveLimits(_state, formData) {
	const admin = await requireAdmin();
	const accountId = String(formData.get("accountId") ?? "");
	if (!isValidObjectId(accountId)) return { error: "Account not found" };
	const limits = { emailsPerMonth: readLimit(formData.get("emailsPerMonth")), subscribers: readLimit(formData.get("subscribers")) };
	const audio = formData.has("audioCharactersPerMonth") ? readLimit(formData.get("audioCharactersPerMonth")) : null;
	if (Object.values(limits).some(Number.isNaN) || Number.isNaN(audio)) return { error: "Use whole numbers, or leave empty for the plan's" };

	if (!(await setLimitOverrides(accountId, limits))) return { error: "Account not found" };
	if (audio !== null) await setAudioLimitOverride(accountId, audio);
	console.info(`[admin] ${admin.email} set limits for account ${accountId}: ${JSON.stringify({ ...limits, ...(audio !== null && { audioCharactersPerMonth: audio }) })}`);
	revalidatePath("/admin");
	return { ok: true, savedAt: Date.now() };
}

export async function giveFreePlan(_state, formData) {
	const admin = await requireAdmin();
	if (!isCloud()) return { error: "There are no plans on a self-hosted server" };
	const accountId = String(formData.get("accountId") ?? "");
	if (!isValidObjectId(accountId)) return { error: "Account not found" };
	const plan = getPlan(String(formData.get("plan") ?? ""));
	if (!plan) return { error: "Pick a plan" };
	const until = readEndDate(formData.get("until"));
	if (until && !(until > new Date())) return { error: "Pick an end date after today, or none" };

	if (!(await grantFreePlan({ accountId, plan: plan.id, until, by: admin.email }))) return { error: "Account not found" };
	console.info(`[admin] ${admin.email} gave account ${accountId} a free ${plan.name} plan${until ? ` until ${until.toISOString()}` : ""}`);
	revalidatePath("/admin");
	return { ok: true, savedAt: Date.now() };
}

export async function endFreePlan(accountId) {
	const admin = await requireAdmin();
	if (!isValidObjectId(accountId)) return { error: "Account not found" };
	if (!(await revokeFreePlan(accountId))) return { error: "No free plan to end" };
	console.info(`[admin] ${admin.email} ended the free plan of account ${accountId}`);
	revalidatePath("/admin");
	return { ok: true };
}

// The never-email list's entry for an address. The address is a reader's, so the logs never name it.
export async function findUndeliverableAddress(email) {
	await requireAdmin();
	const address = normalizeEmail(email);
	if (!address) return { error: "Enter a valid email" };
	const entry = await getGlobalSuppression(address);
	if (!entry) return { email: address, entry: null };
	const { reason, detail, createdAt, expiresAt } = entry;
	return { email: address, entry: { reason, detail: detail ?? null, listedAt: createdAt.toISOString(), expiresAt: expiresAt?.toISOString() ?? null } };
}

// For a false positive: the contacts the list stopped with this address, in every account, are active again.
export async function removeUndeliverableAddress(email) {
	const admin = await requireAdmin();
	const address = normalizeEmail(email);
	if (!address) return { error: "Enter a valid email" };
	const removed = await removeGlobalSuppression(address);
	if (!removed) return { error: "Not on the list" };
	console.info(`[admin] ${admin.email} took an address off the never-email list: ${removed.restored} contacts active again`);
	revalidatePath("/admin");
	return { ok: true, restored: removed.restored };
}

// A Custom plan request's status and the admins' notes (lib/custom-requests.js).
export async function saveCustomRequest(_state, formData) {
	const admin = await requireAdmin();
	const id = String(formData.get("id") ?? "");
	if (!isValidObjectId(id)) return { error: "Request not found" };
	const { problem } = await updateCustomRequest(id, { status: formData.get("status"), notes: formData.get("notes") });
	if (problem) return { error: problem };
	console.info(`[admin] ${admin.email} updated Custom plan request ${id}`);
	revalidatePath("/admin/custom");
	return { ok: true, savedAt: Date.now() };
}

// For a person who asked us to delete theirs (the privacy policy says they can).
export async function removeCustomRequest(id) {
	const admin = await requireAdmin();
	if (!(await deleteCustomRequest(String(id ?? "")))) return { error: "Request not found" };
	console.info(`[admin] ${admin.email} deleted Custom plan request ${id}`);
	revalidatePath("/admin/custom");
	return { ok: true };
}
