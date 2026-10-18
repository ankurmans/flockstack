import "server-only";
import {
	createCustomHostname,
	createWorkerRoute,
	deleteCustomHostname,
	deleteWorkerRoute,
	findCustomHostname,
	getCustomHostname,
	listWorkerRoutes,
	refreshCustomHostname,
} from "@/lib/cloudflare-api";
import { isCloud } from "@/lib/config";
import { connectDb } from "@/lib/db";
import { getRegion } from "@/lib/region";
import { getSharedDnsDriverId } from "@/lib/shared-dns";
import Domain from "@/models/Domain";

// On Cloudflare, a customer's archive subdomain CNAMEd to ARCHIVE_CNAME_TARGET only reaches FlockStack as a Cloudflare
// for SaaS custom hostname on the SaaS zone: without one, Cloudflare blocks a CNAME into another account's zone. Each
// gets a Worker route of its own, <hostname>/*, to the Worker of the region its account lives in, which a single */*
// route couldn't do for two Workers.
const WORKER_NAMES = { us: "flockstack", eu: "flockstack-eu" };
// Cloudflare validates the certificate over HTTP on its own once the CNAME is in: nothing more for the customer to add.
export const CUSTOM_HOSTNAME_SSL = { method: "http", type: "dv", settings: { min_tls_version: "1.2" } };
const BLOCKED_STATUSES = ["blocked", "pending_blocked", "test_blocked"];
const ACTIVE_STATUSES = ["active", "active_redeploying"];

function read(env, name) {
	return String(env[name] ?? "").trim();
}

export function getWorkerName(env = process.env) {
	return read(env, "FLOCKSTACK_WORKER_NAME") || WORKER_NAMES[getRegion(env)];
}

// FlockStack Cloud with the SaaS zone, a CNAME target and a token. Anything else checks the customer's CNAME, as before.
export function getCustomHostnameConfig(env = process.env) {
	const zoneId = read(env, "CLOUDFLARE_SAAS_ZONE_ID");
	const target = read(env, "ARCHIVE_CNAME_TARGET").toLowerCase();
	if (!isCloud(env) || !zoneId || !target || !read(env, "CLOUDFLARE_API_TOKEN")) return null;
	return { zoneId, target, worker: getWorkerName(env) };
}

function getPattern(host) {
	return `${host}/*`;
}

// One of: pending_validation (the CNAME isn't there or Cloudflare hasn't seen it), pending_certificate, active, blocked
// (Cloudflare refuses the hostname). conflict and unavailable are FlockStack's own.
export function getHostnameState(hostname) {
	if (BLOCKED_STATUSES.includes(hostname.status)) return "blocked";
	if (!ACTIVE_STATUSES.includes(hostname.status)) return "pending_validation";
	return hostname.ssl?.status === "active" ? "active" : "pending_certificate";
}

// The TXT records Cloudflare asks for: the hostname's ownership while it's pending, and the certificate's if it ever
// falls back to TXT validation.
export function getValidationRecords(hostname) {
	const records = [];
	const ownership = hostname.ownership_verification;
	if (!ACTIVE_STATUSES.includes(hostname.status) && ownership?.type === "txt" && ownership.name && ownership.value) {
		records.push({ type: "TXT", name: ownership.name, value: ownership.value });
	}
	for (const { txt_name: name, txt_value: value } of hostname.ssl?.validation_records ?? []) {
		if (name && value && !records.some((item) => item.name === name && item.value === value)) records.push({ type: "TXT", name, value });
	}
	return records;
}

function getErrors(hostname) {
	return [...(hostname.verification_errors ?? []), ...(hostname.ssl?.validation_errors ?? []).map(({ message }) => message)].filter(Boolean);
}

// Moved (the CNAME went, or never came in time) and a validation that timed out stay so until asked again.
function needsRefresh(hostname) {
	return hostname.status === "moved" || /_timed_out$/.test(hostname.ssl?.status ?? "");
}

function toStored(hostname, { route, worker }) {
	return {
		id: hostname.id,
		routeId: route.id,
		worker,
		status: hostname.status,
		sslStatus: hostname.ssl?.status ?? null,
		state: getHostnameState(hostname),
		records: getValidationRecords(hostname),
		errors: getErrors(hostname),
		checkedAt: new Date(),
	};
}

// The route goes first: a route to this region's Worker is what marks the hostname as this region's, so whatever a
// failure halfway leaves is found again, and another region's hostname is never touched.
export async function setUpCustomHostname(domain, config = getCustomHostnameConfig()) {
	const host = domain.archiveHost;
	const pattern = getPattern(host);
	const existing = (await listWorkerRoutes(config.zoneId)).find((route) => route.pattern === pattern);
	const route = existing ?? (await createWorkerRoute(config.zoneId, { pattern, script: config.worker }));
	if (route.script !== config.worker) {
		return { state: "conflict", worker: route.script ?? null, records: [], errors: [`${host} is routed to another FlockStack region`], checkedAt: new Date() };
	}
	const storedId = domain.customHostname?.id;
	let hostname = (storedId && (await getCustomHostname(config.zoneId, storedId))) || (await createCustomHostname(config.zoneId, host, CUSTOM_HOSTNAME_SSL));
	if (needsRefresh(hostname)) hostname = await refreshCustomHostname(config.zoneId, hostname.id, CUSTOM_HOSTNAME_SSL);
	return toStored(hostname, { route, worker: config.worker });
}

const PENDING_STATES = ["pending_validation", "pending_certificate", "unavailable"];

// For /admin: what this deployment does with archive subdomains and shared addresses' DNS, and how many hostnames
// are where, as the last checks found them.
export async function getCloudflareDomainsStatus(env = process.env) {
	const config = getCustomHostnameConfig(env);
	const sharedDns = getSharedDnsDriverId(env) === "cloudflare" ? "cloudflare" : env.DNS_BROKER_URL && env.DNS_BROKER_SECRET ? "broker" : "off";
	if (!config) return { customHostnames: null, sharedDns };
	await connectDb();
	const count = (states) => Domain.countDocuments({ "customHostname.state": { $in: states } }).setOptions({ crossAccount: true });
	const [active, pending, refused] = await Promise.all([count(["active"]), count(PENDING_STATES), count(["blocked", "conflict"])]);
	return { customHostnames: { worker: config.worker, target: config.target, active, pending, refused }, sharedDns };
}

// The route and the hostname, when the route is this region's. One that's gone already is done.
export async function removeCustomHostname(domain, config = getCustomHostnameConfig()) {
	const host = domain.archiveHost;
	const route = (await listWorkerRoutes(config.zoneId)).find(({ pattern }) => pattern === getPattern(host));
	if (route && route.script !== config.worker) return { removed: false };
	const id = domain.customHostname?.id ?? (route ? (await findCustomHostname(config.zoneId, host))?.id : null);
	if (route) await deleteWorkerRoute(config.zoneId, route.id);
	if (id) await deleteCustomHostname(config.zoneId, id);
	return { removed: Boolean(route || id) };
}
