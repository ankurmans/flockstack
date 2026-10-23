import "server-only";
import { isSendingEnabled } from "@/lib/config";

// The AWS SDK is 600 KB of script that a dashboard page never needs: it loads when the first call to AWS is made (a send, a domain
// check), not when this module does, which every request that signs in or checks an account's state would otherwise pay for. A command
// is described here by its name and input and built from the SDK just before it is sent. tests/ses-lazy.test.mjs checks that every
// name is one the SDK has and that nothing imports it statically.
let sdk;
function loadSdk() {
	sdk ??= import("@aws-sdk/client-sesv2");
	return sdk;
}

function lazyCommand(name) {
	return class {
		constructor(input) {
			this.commandName = name;
			this.input = input;
		}
	};
}

const CreateConfigurationSetCommand = lazyCommand("CreateConfigurationSetCommand");
const CreateConfigurationSetEventDestinationCommand = lazyCommand("CreateConfigurationSetEventDestinationCommand");
const CreateDedicatedIpPoolCommand = lazyCommand("CreateDedicatedIpPoolCommand");
const CreateEmailIdentityCommand = lazyCommand("CreateEmailIdentityCommand");
const CreateTenantCommand = lazyCommand("CreateTenantCommand");
const CreateTenantResourceAssociationCommand = lazyCommand("CreateTenantResourceAssociationCommand");
const DeleteConfigurationSetCommand = lazyCommand("DeleteConfigurationSetCommand");
const DeleteDedicatedIpPoolCommand = lazyCommand("DeleteDedicatedIpPoolCommand");
const DeleteEmailIdentityCommand = lazyCommand("DeleteEmailIdentityCommand");
const DeleteTenantCommand = lazyCommand("DeleteTenantCommand");
const DeleteTenantResourceAssociationCommand = lazyCommand("DeleteTenantResourceAssociationCommand");
const GetAccountCommand = lazyCommand("GetAccountCommand");
const GetDedicatedIpCommand = lazyCommand("GetDedicatedIpCommand");
const GetDedicatedIpsCommand = lazyCommand("GetDedicatedIpsCommand");
const GetEmailIdentityCommand = lazyCommand("GetEmailIdentityCommand");
const GetTenantCommand = lazyCommand("GetTenantCommand");
const PutConfigurationSetDeliveryOptionsCommand = lazyCommand("PutConfigurationSetDeliveryOptionsCommand");
const PutDedicatedIpInPoolCommand = lazyCommand("PutDedicatedIpInPoolCommand");
const PutDedicatedIpWarmupAttributesCommand = lazyCommand("PutDedicatedIpWarmupAttributesCommand");
const PutEmailIdentityMailFromAttributesCommand = lazyCommand("PutEmailIdentityMailFromAttributesCommand");
const SendEmailCommand = lazyCommand("SendEmailCommand");
const UpdateReputationEntityCustomerManagedStatusCommand = lazyCommand("UpdateReputationEntityCustomerManagedStatusCommand");
const UpdateReputationEntityPolicyCommand = lazyCommand("UpdateReputationEntityPolicyCommand");

// Every call to AWS lives in this file, so tests replace it whole (tests/stubs/ses.mjs).
// Read when used, not when the module loads: on Workers the environment only exists once a request is running.
function getRegion() {
	return process.env.SES_REGION || "us-east-1";
}
const CACHE_TTL_MS = 5 * 60_000;
// Reads only: a send that timed out could still have gone out, and the SDK would retry it.
const READ_TIMEOUT_MS = 5000;
const EVENT_TYPES = ["SEND", "REJECT", "BOUNCE", "COMPLAINT", "DELIVERY", "DELIVERY_DELAY", "RENDERING_FAILURE"];
const cache = new Map();
let client;

// Only FlockStack's own keys: never the default AWS chain (~/.aws, instance roles), which could belong to
// another AWS account. Vercel reserves the AWS_* names, hence SES_*.
function getCredentials() {
	const { SES_ACCESS_KEY_ID: accessKeyId, SES_SECRET_ACCESS_KEY: secretAccessKey } = process.env;
	if (!accessKeyId || !secretAccessKey) throw new Error("SES is not configured (SES_ACCESS_KEY_ID, SES_SECRET_ACCESS_KEY)");
	return { accessKeyId, secretAccessKey };
}

async function getClient() {
	const { SESv2Client } = await loadSdk();
	client ??= new SESv2Client({ region: getRegion(), credentials: getCredentials() });
	return client;
}

// A described command (see lazyCommand), sent through the client.
async function send(described, options) {
	const { [described.commandName]: Command } = await loadSdk();
	return (await getClient()).send(new Command(described.input), options);
}

function read(command) {
	return send(command, { abortSignal: AbortSignal.timeout(READ_TIMEOUT_MS) });
}

function write(command) {
	return send(command);
}

// Creating what already exists is how retries land here: it counts as done.
async function writeOnce(command) {
	try {
		return await write(command);
	} catch (error) {
		if (error?.name === "AlreadyExistsException") return null;
		throw error;
	}
}

// Deleting what's gone already counts as done too.
async function deleteOnce(command) {
	try {
		await write(command);
	} catch (error) {
		if (error?.name !== "NotFoundException") throw error;
	}
}

function getAwsAccountId() {
	const id = process.env.SES_AWS_ACCOUNT_ID;
	if (!/^\d{12}$/.test(id ?? "")) throw new Error("SES is not configured (SES_AWS_ACCOUNT_ID)");
	return id;
}

export function getIdentityArn(identity) {
	return `arn:aws:ses:${getRegion()}:${getAwsAccountId()}:identity/${identity}`;
}

function getConfigurationSetArn(name) {
	return `arn:aws:ses:${getRegion()}:${getAwsAccountId()}:configuration-set/${name}`;
}

function getReputationPolicyArn(policy) {
	return `arn:aws:ses:${getRegion()}:aws:reputation-policy/${policy}`;
}

async function cached(key, { fresh }, load) {
	const hit = cache.get(key);
	if (!fresh && hit && hit.expiresAt > Date.now()) return hit.promise;
	const entry = { promise: load(), expiresAt: Date.now() + CACHE_TTL_MS };
	cache.set(key, entry);
	const value = await entry.promise;
	if (value?.error && cache.get(key) === entry) cache.delete(key);
	return value;
}

// The AWS account as a whole, for the admin page.
export function getSesAccount({ fresh = false } = {}) {
	return cached("account", { fresh }, loadSesAccount);
}

async function loadSesAccount() {
	try {
		const account = await read(new GetAccountCommand({}));
		return {
			productionAccess: Boolean(account.ProductionAccessEnabled),
			reviewStatus: account.Details?.ReviewDetails?.Status || null,
			sendingEnabled: Boolean(account.SendingEnabled),
			enforcementStatus: account.EnforcementStatus,
			max24HourSend: account.SendQuota?.Max24HourSend ?? 0,
			maxSendRate: account.SendQuota?.MaxSendRate ?? 0,
			sentLast24Hours: account.SendQuota?.SentLast24Hours ?? 0,
		};
	} catch (error) {
		return { error: error.message };
	}
}

// One configuration set per customer account: its events go to the SNS topic of /api/webhooks/ses.
export async function createConfigurationSet(name) {
	const topicArn = process.env.SES_SNS_TOPIC_ARN;
	if (!topicArn) throw new Error("SES is not configured (SES_SNS_TOPIC_ARN)");
	await writeOnce(new CreateConfigurationSetCommand({ ConfigurationSetName: name, ReputationOptions: { ReputationMetricsEnabled: true } }));
	await writeOnce(
		new CreateConfigurationSetEventDestinationCommand({
			ConfigurationSetName: name,
			EventDestinationName: "flockstack-events",
			EventDestination: { Enabled: true, MatchingEventTypes: EVENT_TYPES, SnsDestination: { TopicArn: topicArn } },
		})
	);
}

// Each tenant keeps its own suppression list, like each account keeps its own in FlockStack.
export async function createTenant(name, { accountId }) {
	await writeOnce(
		new CreateTenantCommand({
			TenantName: name,
			Tags: [{ Key: "account_id", Value: String(accountId) }],
			SuppressionAttributes: { SuppressionScope: "TENANT", SuppressedReasons: ["BOUNCE", "COMPLAINT"] },
		})
	);
	const { Tenant: tenant } = await read(new GetTenantCommand({ TenantName: name }));
	await write(
		new UpdateReputationEntityPolicyCommand({
			ReputationEntityType: "RESOURCE",
			ReputationEntityReference: tenant.TenantArn,
			ReputationEntityPolicy: getReputationPolicyArn("standard"),
		})
	);
	return { tenantArn: tenant.TenantArn, sendingStatus: tenant.SendingStatus ?? null };
}

export async function associateTenantResources(tenantName, { identities = [], configurationSets = [] }) {
	const arns = [...identities.map(getIdentityArn), ...configurationSets.map(getConfigurationSetArn)];
	for (const arn of arns) await writeOnce(new CreateTenantResourceAssociationCommand({ TenantName: tenantName, ResourceArn: arn }));
}

export function dissociateTenantIdentity(tenantName, identity) {
	return deleteOnce(new DeleteTenantResourceAssociationCommand({ TenantName: tenantName, ResourceArn: getIdentityArn(identity) }));
}

// An account's purge, once its identities are gone: SES drops the tenant's associations with it.
export async function deleteTenant(name) {
	await deleteOnce(new DeleteTenantCommand({ TenantName: name }));
}

export async function deleteConfigurationSet(name) {
	await deleteOnce(new DeleteConfigurationSetCommand({ ConfigurationSetName: name }));
}

// After an admin resumes an account that SES paused. REINSTATED lets it send while findings stay open.
export async function reinstateTenant(tenantArn) {
	await write(
		new UpdateReputationEntityCustomerManagedStatusCommand({
			ReputationEntityType: "RESOURCE",
			ReputationEntityReference: tenantArn,
			SendingStatus: "REINSTATED",
		})
	);
}

// Dedicated IPs are standard ones: AWS leases them (a support case, there is no API for it: lib/ip-inventory.js), and from
// then on every step is an API call. A pool is a STANDARD one, which holds the IPs we move into it and nothing else.
export async function createDedicatedIpPool(name) {
	await writeOnce(new CreateDedicatedIpPoolCommand({ PoolName: name, ScalingMode: "STANDARD" }));
}

function toDedicatedIp({ Ip, PoolName, WarmupPercentage, WarmupStatus }) {
	return { ip: Ip, poolName: PoolName ?? null, warmupPercentage: WarmupPercentage ?? null, warmupStatus: WarmupStatus ?? null };
}

// Every dedicated IP the AWS account has leased, with its pool and its warm-up status.
export async function listDedicatedIps() {
	const ips = [];
	let nextToken;
	do {
		const page = await read(new GetDedicatedIpsCommand({ NextToken: nextToken, PageSize: 100 }));
		ips.push(...(page.DedicatedIps ?? []).map(toDedicatedIp));
		nextToken = page.NextToken;
	} while (nextToken);
	return ips;
}

// One of them, or null when the AWS account doesn't have it (it was never leased, or it was relinquished).
export async function getDedicatedIp(ip) {
	try {
		const { DedicatedIp: found } = await read(new GetDedicatedIpCommand({ Ip: ip }));
		return toDedicatedIp(found);
	} catch (error) {
		if (error?.name === "NotFoundException") return null;
		throw error;
	}
}

export async function moveDedicatedIpToPool(ip, poolName) {
	await write(new PutDedicatedIpInPoolCommand({ Ip: ip, DestinationPoolName: poolName }));
}

// 100 marks the warm-up complete, so SES's own automatic warm-up (on by default for standard IPs) doesn't hold the IP back
// under ours: FlockStack ramps the share of an account's email that goes through the pool itself (lib/ip-warmup-rules.js).
export async function setDedicatedIpWarmupPercentage(ip, percentage) {
	await write(new PutDedicatedIpWarmupAttributesCommand({ Ip: ip, WarmupPercentage: percentage }));
}

export async function setConfigurationSetPool(configurationSet, poolName) {
	await write(
		new PutConfigurationSetDeliveryOptionsCommand({
			ConfigurationSetName: configurationSet,
			SendingPoolName: poolName ?? undefined,
			TlsPolicy: "OPTIONAL",
		})
	);
}

export async function deleteDedicatedIpPool(name) {
	await deleteOnce(new DeleteDedicatedIpPoolCommand({ PoolName: name }));
}

// Easy DKIM with 2048-bit keys, and a custom MAIL FROM so SPF aligns with the customer's domain.
export async function createDomainIdentity(domain, { configurationSet, mailFromDomain }) {
	await writeOnce(
		new CreateEmailIdentityCommand({
			EmailIdentity: domain,
			DkimSigningAttributes: { NextSigningKeyLength: "RSA_2048_BIT" },
			ConfigurationSetName: configurationSet,
		})
	);
	await write(
		new PutEmailIdentityMailFromAttributesCommand({
			EmailIdentity: domain,
			MailFromDomain: mailFromDomain,
			BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
		})
	);
}

export function deleteDomainIdentity(domain) {
	return deleteOnce(new DeleteEmailIdentityCommand({ EmailIdentity: domain }));
}

function dnsRecords(domain, identity) {
	const dkim = (identity.DkimAttributes?.Tokens || []).map((token) => ({
		purpose: "dkim",
		type: "CNAME",
		name: `${token}._domainkey.${domain}`,
		value: `${token}.dkim.amazonses.com`,
	}));
	const mailFrom = identity.MailFromAttributes?.MailFromDomain;
	const bounce = mailFrom
		? [
				{ purpose: "mail-from", type: "MX", name: mailFrom, value: `10 feedback-smtp.${getRegion()}.amazonses.com` },
				{ purpose: "mail-from", type: "TXT", name: mailFrom, value: "v=spf1 include:amazonses.com ~all" },
			]
		: [];
	return [...dkim, ...bounce];
}

// One domain, read fresh: the domains page and "Check now" only ever ask for the account's own.
export async function getDomainIdentity(domain) {
	try {
		const identity = await read(new GetEmailIdentityCommand({ EmailIdentity: domain }));
		return {
			verified: Boolean(identity.VerifiedForSendingStatus),
			dkimStatus: identity.DkimAttributes?.Status || "NOT_STARTED",
			mailFromStatus: identity.MailFromAttributes?.MailFromDomainStatus || null,
			records: dnsRecords(domain, identity),
		};
	} catch (error) {
		if (error?.name === "NotFoundException") return { missing: true };
		return { error: error.message };
	}
}

// FlockStack's own emails on a self-hosted server without Resend: from EMAIL_FROM, on any identity the AWS account
// verified, outside every tenant. SENDING_ENABLED is for customers' emails; sign-in codes go before sending is on.
export async function sendSesPlatformEmail({ from, to, replyTo, subject, text, html }) {
	const result = await send(
		new SendEmailCommand({
			FromEmailAddress: from,
			Destination: { ToAddresses: [to] },
			ReplyToAddresses: replyTo ? [replyTo] : undefined,
			Content: {
				Simple: {
					Subject: { Data: subject, Charset: "UTF-8" },
					Body: { Text: { Data: text, Charset: "UTF-8" }, ...(html && { Html: { Data: html, Charset: "UTF-8" } }) },
				},
			},
		})
	);
	return { sesMessageId: result.MessageId };
}

export async function sendSesEmail({ from, to, replyTo, subject, html, text, headers = {}, tags = [], tenantName, configurationSet }) {
	if (!isSendingEnabled()) throw new Error("Sending is off (SENDING_ENABLED is not true)");
	if (!tenantName || !configurationSet) throw new Error("Every email needs the account's SES tenant and configuration set");

	const result = await send(
		new SendEmailCommand({
			FromEmailAddress: from,
			Destination: { ToAddresses: [to] },
			ReplyToAddresses: replyTo ? [replyTo] : undefined,
			ConfigurationSetName: configurationSet,
			TenantName: tenantName,
			EmailTags: tags.map(({ name, value }) => ({ Name: name, Value: value })),
			Content: {
				Simple: {
					Subject: { Data: subject, Charset: "UTF-8" },
					Body: {
						Html: { Data: html, Charset: "UTF-8" },
						Text: { Data: text, Charset: "UTF-8" },
					},
					Headers: Object.entries(headers).map(([Name, Value]) => ({ Name, Value })),
				},
			},
		})
	);
	return { sesMessageId: result.MessageId };
}
