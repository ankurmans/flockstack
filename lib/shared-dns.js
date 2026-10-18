import "server-only";
import { createDnsRecord, deleteDnsRecord, isCloudflareConfigured, listDnsRecords, updateDnsRecord } from "@/lib/cloudflare-api";
import { publishSharedRecords as publishThroughBroker, removeSharedRecords as removeThroughBroker } from "@/lib/dns-broker";
import { isRateLimited } from "@/lib/rate-limit";

// Where a shared address's DNS records go: the zone of SHARED_DOMAIN on Cloudflare, through Cloudflare's API, once
// CLOUDFLARE_SHARED_ZONE_ID and CLOUDFLARE_API_TOKEN are set. Otherwise the DNS helper (lib/dns-broker.js), which a
// self-hosted server may run on Vercel. A newsletter keeps the driver its records went through (sharedSender.dnsDriver),
// so they're removed where they are even after the setting changes.
export const DNS_DRIVERS = { cloudflare: "Cloudflare DNS", broker: "DNS helper" };
// Like the DNS helper's cap of 900 records a day: about 150 shared addresses of 6 records each.
const DEFAULT_DAILY_CAP = 150;
const MARKER = "flockstack shared address";

function getSharedZoneId(env = process.env) {
	return String(env.CLOUDFLARE_SHARED_ZONE_ID ?? "").trim() || null;
}

export function getSharedDnsDriverId(env = process.env) {
	return getSharedZoneId(env) && isCloudflareConfigured(env) ? "cloudflare" : "broker";
}

function getDailyCap(env = process.env) {
	const cap = Number.parseInt(env.CLOUDFLARE_DNS_DAILY_CAP, 10);
	return Number.isInteger(cap) && cap >= 1 ? cap : DEFAULT_DAILY_CAP;
}

function getComment(slug) {
	return `${MARKER}: ${slug}`;
}

// helperProblem as the DNS helper's client reports it: "cap" waits for the cap or Cloudflare's rate limit, "down" is a
// token, zone or Cloudflare failing for every slug; null is one slug's records refused.
function toError(slug, error) {
	const helperProblem = error.helperProblem !== undefined ? error.helperProblem : error.isRateLimited ? "cap" : error.isAuth || error.isUnavailable ? "down" : null;
	return Object.assign(new Error(`Cloudflare refused ${slug}'s records: ${error.message}`), { status: error.status ?? null, helperProblem, dnsDriver: "cloudflare" });
}

// DNS only: SES has to read the DKIM CNAMEs and the return path's MX and TXT as they are. The web record is the one
// proxied, so Cloudflare serves the subdomain's archive through the Worker route on SHARED_DOMAIN.
function toCloudflareRecord(slug, { purpose, type, name, value }) {
	const base = { type, name, ttl: 1, proxied: purpose === "web", comment: getComment(slug) };
	if (type !== "MX") return { ...base, content: value };
	const [priority, host] = String(value).trim().split(/\s+/);
	return { ...base, content: host, priority: Number(priority) };
}

// A name taken by one of this slug's own records from before (a failure that left it) is updated; anyone else's is
// refused, never overwritten.
async function publishOne(zoneId, slug, record) {
	const wanted = toCloudflareRecord(slug, record);
	try {
		return await createDnsRecord(zoneId, wanted);
	} catch (error) {
		if (!error.isConflict) throw error;
		const own = (await listDnsRecords(zoneId, { name: wanted.name, type: wanted.type })).find((item) => item.comment === wanted.comment);
		if (!own) throw Object.assign(new Error(`${wanted.type} ${wanted.name} is taken`), { helperProblem: null, status: 409 });
		return { ...(await updateDnsRecord(zoneId, own.id, wanted)), existed: true };
	}
}

async function publishOnCloudflare(slug, records) {
	const zoneId = getSharedZoneId();
	if (await isRateLimited({ name: "shared-dns", limit: getDailyCap(), window: "1 d", key: zoneId })) {
		throw toError(slug, { message: `${getDailyCap()} shared addresses were set up in the last day, the cap (CLOUDFLARE_DNS_DAILY_CAP)`, helperProblem: "cap", status: 429 });
	}
	const published = [];
	try {
		for (const record of records) published.push(await publishOne(zoneId, slug, record));
	} catch (error) {
		await Promise.all(published.filter(({ existed }) => !existed).map(({ id }) => deleteDnsRecord(zoneId, id).catch(() => {})));
		throw toError(slug, error);
	}
	return { ids: published.map(({ id }) => id), dnsDriver: "cloudflare" };
}

// All of a slug's records or none, their ids in the same order.
export async function publishSharedRecords(slug, records, driverId = getSharedDnsDriverId()) {
	if (driverId === "cloudflare") return publishOnCloudflare(slug, records);
	const result = await publishThroughBroker(slug, records);
	return result.skipped ? result : { ids: result.ids, dnsDriver: "broker" };
}

// Through the driver they were published with. Cloudflare no longer set up leaves them, with a warning.
export async function removeSharedRecords(slug, ids = [], driverId = "broker") {
	if (ids.length === 0) return { deleted: [] };
	if (driverId !== "cloudflare") return removeThroughBroker(slug, ids);
	const zoneId = getSharedZoneId();
	if (!zoneId || !isCloudflareConfigured()) {
		console.warn(`[shared-dns] ${slug}'s records stay on Cloudflare: CLOUDFLARE_SHARED_ZONE_ID or CLOUDFLARE_API_TOKEN isn't set`);
		return { skipped: true };
	}
	try {
		for (const id of ids) await deleteDnsRecord(zoneId, id);
	} catch (error) {
		throw toError(slug, error);
	}
	return { deleted: ids };
}
