import "server-only";
import { LIMITS } from "@/lib/config";
import { connectDb } from "@/lib/db";
import { assignDedicatedIp, releaseDedicatedIp } from "@/lib/ip-assignment";
import { getDedicatedConfigurationSetName, pickConfigurationSet } from "@/lib/ip-warmup-rules";
import {
	associateTenantResources,
	createConfigurationSet,
	createDomainIdentity,
	createTenant,
	deleteConfigurationSet,
	deleteDomainIdentity,
	deleteTenant,
	dissociateTenantIdentity,
	getDomainIdentity,
	reinstateTenant,
	sendSesEmail,
	sendSesPlatformEmail,
} from "@/lib/ses";
import Account from "@/models/Account";
import Domain from "@/models/Domain";

// SES allows 64 letters, digits, - and _: the account id fits and never changes.
export function getTenantName(accountId) {
	return `mc-${accountId}`;
}

function getTenant(account) {
	return account?.ses?.provisionedAt ? account.ses : null;
}

// One SES tenant per account, with its own configuration set and the account's own domains. Every step is
// safe to repeat, so a failed attempt is finished by the next one. Shared addresses are identities of their own
// (lib/shared-sender.js), added like domains.
async function provisionTenant(accountId) {
	await connectDb();
	const account = await Account.findById(accountId).select({ ses: 1 }).lean();
	if (!account) throw new Error("Account not found");
	if (account.ses?.provisionedAt) return account.ses;

	const name = getTenantName(account._id);
	await createConfigurationSet(name);
	const { tenantArn, sendingStatus } = await createTenant(name, { accountId: account._id });
	const domains = await Domain.find({ accountId: account._id, provider: { $in: ["ses", null] } }).select({ domain: 1 }).lean();
	await associateTenantResources(name, { identities: domains.map(({ domain }) => domain), configurationSets: [name] });

	const ses = {
		...account.ses,
		tenantName: name,
		tenantArn,
		configurationSet: name,
		provisionedAt: new Date(),
		tenantStatus: sendingStatus ?? account.ses?.tenantStatus,
	};
	await Account.updateOne({ _id: account._id }, { $set: { ses } });
	return ses;
}

async function ensureTenant(account) {
	return getTenant(account) ?? provisionTenant(account._id);
}

// FlockStack's own block is what holds an account on SES; SES pauses tenants itself (lib/tenant-events.js).
async function suspendTenant() {}

// After an admin unblocks an account that SES paused. REINSTATED lets it send while findings stay open.
async function resumeTenant(accountId) {
	await connectDb();
	const account = await Account.findById(accountId).select({ ses: 1, pausedBy: 1 }).lean();
	const isPausedBySes = account?.pausedBy === "ses" || account?.ses?.tenantStatus === "DISABLED";
	if (!account?.ses?.tenantArn || !isPausedBySes) return false;
	await reinstateTenant(account.ses.tenantArn);
	await Account.updateOne({ _id: account._id }, { $set: { "ses.tenantStatus": "REINSTATED", "ses.tenantStatusAt": new Date() } });
	return true;
}

// Shared IPs are the default for every account. A dedicated IP is one of the standard IPs the AWS account leased
// (lib/ip-inventory.js): it goes into a pool of the account's own, and a growing share of the account's email goes through
// it while it warms up (lib/ip-assignment.js, lib/ip-warmup-rules.js). Every step is safe to repeat. Returns false for an
// account that isn't there, else what happened: { status: "assigned" | "already" | "waiting" | "released" | "none", ip }.
async function setDedicatedIp(accountId, isOn) {
	await connectDb();
	const account = await Account.findById(accountId).select({ ses: 1 }).lean();
	if (!account) return false;
	const tenant = await ensureTenant(account);
	return isOn ? assignDedicatedIp(accountId, tenant) : releaseDedicatedIp(accountId, tenant);
}

// Easy DKIM, and a custom MAIL FROM so SPF aligns with the domain.
const RETURN_PATH_PREFIX = "bounce";

function getMailFromDomain(domain) {
	return `${RETURN_PATH_PREFIX}.${domain}`;
}

async function addDomain({ account, domain }) {
	const { tenantName, configurationSet } = await ensureTenant(account);
	await createDomainIdentity(domain, { configurationSet, mailFromDomain: getMailFromDomain(domain) });
	await associateTenantResources(tenantName, { identities: [domain] });
	return { providerDomainId: null };
}

// Read fresh: SES has no budget on reads that matters here.
function readDomain({ domain }) {
	return getDomainIdentity(domain.domain);
}

async function removeDomain({ account, domain }) {
	if (account.ses?.tenantName) await dissociateTenantIdentity(account.ses.tenantName, domain.domain);
	await deleteDomainIdentity(domain.domain);
}

// SES's rate is one number for every customer and every kind of email (lib/send-rate.js).
function getSendLane() {
	return { name: "ses", rate: LIMITS.sendRatePerSecond };
}

// SES returns tags with every event, so a bounce or complaint always says which account it belongs to.
function getMessageTags(message) {
	const tags = [
		{ name: "message_id", value: String(message._id) },
		{ name: "account_id", value: String(message.accountId) },
		{ name: "kind", value: message.kind },
	];
	if (message.campaignId) tags.push({ name: "campaign_id", value: String(message.campaignId) });
	return tags;
}

// An account with a dedicated IP has two configuration sets, one on shared IPs and one on its pool, and each email takes
// one by its id, so a retry takes the same (SES has no pool per message). If the pool's set is refused, as when an admin
// takes the IP away while a batch is running, that email goes through shared IPs instead: the refusal comes before anything is sent.
async function sendEmail({ tenant, message, email, feedbackId }) {
	const { configurationSet, isDedicated } = pickConfigurationSet(tenant, message._id);
	const send = (set) =>
		sendSesEmail({
			...email,
			headers: { ...email.headers, "Feedback-ID": feedbackId },
			tags: getMessageTags(message),
			tenantName: tenant.tenantName,
			configurationSet: set,
		});
	try {
		const { sesMessageId } = await send(configurationSet);
		return { providerMessageId: sesMessageId };
	} catch (error) {
		if (!isDedicated || !["NotFoundException", "BadRequestException"].includes(error?.name)) throw error;
		console.error(`[ip] ${configurationSet} refused an email of account ${message.accountId}, so it goes through shared IPs:`, error.message);
		const { sesMessageId } = await send(tenant.configurationSet);
		return { providerMessageId: sesMessageId };
	}
}

function describeTenant(account) {
	const tenant = getTenant(account);
	if (!tenant) return null;
	return { id: tenant.tenantName, status: tenant.tenantStatus ?? null, detail: tenant.lastFinding ?? null, ...(tenant.dedicatedPool && { dedicatedIp: describeDedicatedIp(tenant) }) };
}

// What the admin page says of an account's dedicated IP. A pool without an address is a managed one from before.
function describeDedicatedIp({ dedicatedIpAddress, ipWarmup }) {
	if (!dedicatedIpAddress) return { isManaged: true };
	const isDone = Boolean(ipWarmup?.completedAt);
	return { ip: dedicatedIpAddress, day: isDone ? null : (ipWarmup?.day ?? null), share: isDone ? 100 : (ipWarmup?.share ?? null), isDone };
}

// An account's purge, once its identities are gone: its IP goes back to the inventory while the configuration sets it
// leaves are still there, then the tenant and the configuration sets.
async function removeTenant(account) {
	const { tenantName, configurationSet } = account.ses ?? {};
	if (account.ses?.dedicatedPool || account.ses?.dedicatedIpAddress) await releaseDedicatedIp(account._id, account.ses);
	if (tenantName) await deleteTenant(tenantName);
	if (configurationSet) {
		await deleteConfigurationSet(getDedicatedConfigurationSetName(configurationSet));
		await deleteConfigurationSet(configurationSet);
	}
}

function isConfigured() {
	return Boolean(process.env.SES_ACCESS_KEY_ID && process.env.SES_SECRET_ACCESS_KEY);
}

export const sesProvider = Object.freeze({
	id: "ses",
	name: "Amazon SES",
	returnPathPrefix: RETURN_PATH_PREFIX,
	isConfigured,
	sendPlatformEmail: sendSesPlatformEmail,
	getTenant,
	provisionTenant,
	ensureTenant,
	suspendTenant,
	resumeTenant,
	setDedicatedIp,
	describeTenant,
	removeTenant,
	getMailFromDomain,
	addDomain,
	readDomain,
	removeDomain,
	getSendLane,
	sendEmail,
});
