// Cloudflare's API in memory, in place of lib/cloudflare-api.js: custom hostnames, Worker routes and DNS records per
// zone, with the same idempotent creates. Every call is recorded; tests move a hostname along with setHostnameStatus.
export const zones = new Map();
export const calls = [];
const failures = [];
let nextId = 0;

function zone(zoneId) {
	if (!zones.has(zoneId)) zones.set(zoneId, { hostnames: new Map(), routes: new Map(), records: new Map() });
	return zones.get(zoneId);
}

// Errors carry what lib/cloudflare-api.js's CloudflareError does.
export function cloudflareError(status, code, message = "Refused") {
	return Object.assign(new Error(`Cloudflare refused: ${message} (${code})`), {
		status,
		codes: code ? [code] : [],
		isAuth: status === 401 || status === 403,
		isRateLimited: status === 429,
		isUnavailable: status === null || status >= 500,
		isNotFound: status === 404,
		isConflict: status === 409 || [81053, 81054].includes(code),
		isDuplicate: false,
	});
}

// The next call named name (or any call, without a name) throws error, times times.
export function failNext({ name = null, error, times = 1 }) {
	failures.push({ name, error, times });
}

export function resetCloudflare() {
	zones.clear();
	calls.length = 0;
	failures.length = 0;
}

function record(name, args) {
	if (!String(process.env.CLOUDFLARE_API_TOKEN ?? "").trim()) throw cloudflareError(401, 10000, "CLOUDFLARE_API_TOKEN isn't set");
	calls.push({ name, args });
	const failure = failures.find((item) => !item.name || item.name === name);
	if (!failure) return;
	if (--failure.times <= 0) failures.splice(failures.indexOf(failure), 1);
	throw failure.error;
}

export function isCloudflareConfigured(env = process.env) {
	return Boolean(String(env.CLOUDFLARE_API_TOKEN ?? "").trim());
}

const copy = (value) => (value ? structuredClone(value) : value);

// status and ssl.status as Cloudflare reports them; pending hostnames carry their ownership TXT record.
export function setHostnameStatus(zoneId, hostname, { status, sslStatus, validationRecords }) {
	const item = [...zone(zoneId).hostnames.values()].find((entry) => entry.hostname === hostname);
	if (!item) throw new Error(`No custom hostname ${hostname} in ${zoneId}`);
	if (status) item.status = status;
	if (sslStatus) item.ssl.status = sslStatus;
	if (validationRecords) item.ssl.validation_records = validationRecords;
	if (item.status === "active") delete item.ownership_verification;
	return item;
}

export function findHostname(zoneId, hostname) {
	return copy([...zone(zoneId).hostnames.values()].find((entry) => entry.hostname === hostname) ?? null);
}

export function listRoutes(zoneId) {
	return [...zone(zoneId).routes.values()].map(copy);
}

export function listRecords(zoneId) {
	return [...zone(zoneId).records.values()].map(copy);
}

// What a resolver would find at a name in any zone, in the DNS helper stub's shape, for the provider stubs.
export function findCloudflareRecord(name, type) {
	for (const { records } of zones.values()) {
		for (const item of records.values()) if (item.name === name && item.type === type) return { ...item, value: item.content };
	}
	return null;
}

export async function findCustomHostname(zoneId, hostname) {
	record("findCustomHostname", { zoneId, hostname });
	return findHostname(zoneId, hostname);
}

export async function getCustomHostname(zoneId, id) {
	record("getCustomHostname", { zoneId, id });
	return copy(zone(zoneId).hostnames.get(id) ?? null);
}

export async function createCustomHostname(zoneId, hostname, ssl) {
	record("createCustomHostname", { zoneId, hostname, ssl });
	const existing = findHostname(zoneId, hostname);
	if (existing) return { ...existing, existed: true };
	const id = `ch_${++nextId}`;
	const item = {
		id,
		hostname,
		status: "pending",
		ssl: { ...ssl, status: "initializing", validation_records: [] },
		ownership_verification: { type: "txt", name: `_cf-custom-hostname.${hostname}`, value: `verify-${id}` },
		verification_errors: ["custom hostname does not CNAME to this zone."],
	};
	zone(zoneId).hostnames.set(id, item);
	return { ...copy(item), existed: false };
}

export async function refreshCustomHostname(zoneId, id, ssl) {
	record("refreshCustomHostname", { zoneId, id, ssl });
	const item = zone(zoneId).hostnames.get(id);
	if (!item) throw cloudflareError(404, 1436, "Custom hostname not found");
	item.status = "pending";
	item.ssl = { ...item.ssl, ...ssl, status: "pending_validation" };
	return copy(item);
}

export async function deleteCustomHostname(zoneId, id) {
	record("deleteCustomHostname", { zoneId, id });
	return { deleted: zone(zoneId).hostnames.delete(id) };
}

export async function listWorkerRoutes(zoneId) {
	record("listWorkerRoutes", { zoneId });
	return listRoutes(zoneId);
}

export async function createWorkerRoute(zoneId, { pattern, script }) {
	record("createWorkerRoute", { zoneId, pattern, script });
	const existing = listRoutes(zoneId).find((route) => route.pattern === pattern);
	if (existing) return { ...existing, existed: true };
	const route = { id: `route_${++nextId}`, pattern, script };
	zone(zoneId).routes.set(route.id, route);
	return { ...copy(route), existed: false };
}

export async function deleteWorkerRoute(zoneId, id) {
	record("deleteWorkerRoute", { zoneId, id });
	return { deleted: zone(zoneId).routes.delete(id) };
}

export async function listDnsRecords(zoneId, { name, type } = {}) {
	record("listDnsRecords", { zoneId, name, type });
	return listRecords(zoneId).filter((item) => (!name || item.name === name) && (!type || item.type === type));
}

// Like Cloudflare: the same record again is a duplicate, and a CNAME can't share its name with any other record.
export async function createDnsRecord(zoneId, input) {
	record("createDnsRecord", { zoneId, record: input });
	const records = listRecords(zoneId);
	const same = records.find((item) => item.type === input.type && item.name === input.name && item.content === input.content);
	if (same) return { ...same, existed: true };
	if (records.some((item) => item.name === input.name && (item.type === "CNAME" || input.type === "CNAME"))) {
		throw cloudflareError(400, 81053, "An A, AAAA, or CNAME record with that host already exists.");
	}
	const item = { id: `dns_${++nextId}`, ...input };
	zone(zoneId).records.set(item.id, item);
	return { ...copy(item), existed: false };
}

export async function updateDnsRecord(zoneId, id, input) {
	record("updateDnsRecord", { zoneId, id, record: input });
	const item = zone(zoneId).records.get(id);
	if (!item) throw cloudflareError(404, 81044, "Record does not exist.");
	Object.assign(item, input);
	return copy(item);
}

export async function deleteDnsRecord(zoneId, id) {
	record("deleteDnsRecord", { zoneId, id });
	return { deleted: zone(zoneId).records.delete(id) };
}
