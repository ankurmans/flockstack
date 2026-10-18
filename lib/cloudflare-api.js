import "server-only";

// The only module that calls Cloudflare's API (tests replace it with tests/stubs/cloudflare-api.mjs). It acts with
// CLOUDFLARE_API_TOKEN, a token scoped to the zones FlockStack writes to (README, Domains on Cloudflare), read on each
// call: a Worker has no env at module load.
const API_URL = "https://api.cloudflare.com/client/v4";
const TIMEOUT_MS = 15_000;
// Every call here can run twice safely (a create finds what the first one made), so no answer and Cloudflare's own
// failures are tried again. A rate limit isn't: the next check or save tries later.
const RETRY_DELAYS_MS = [300, 1_000];

// Cloudflare's error codes for a token that's missing, malformed, revoked or without the permission asked for.
const AUTH_CODES = [6003, 6111, 9103, 9106, 9109, 10000, 10001];
// A DNS name taken by a record that can't sit next to the one asked for (a CNAME with anything else).
const DNS_CONFLICT_CODES = [81053, 81054, 81055, 81056];
// The same record already exists.
const DNS_DUPLICATE_CODES = [81057, 81058];
const DUPLICATE_HOSTNAME_CODE = 1406;

export class CloudflareError extends Error {
	constructor(message, { status = null, codes = [], cause } = {}) {
		super(message, cause ? { cause } : undefined);
		this.name = "CloudflareError";
		this.status = status;
		this.codes = codes;
		this.isAuth = status === 401 || status === 403 || codes.some((code) => AUTH_CODES.includes(code));
		this.isRateLimited = status === 429;
		this.isUnavailable = status === null || status >= 500;
		this.isNotFound = status === 404;
		this.isConflict = status === 409 || codes.some((code) => DNS_CONFLICT_CODES.includes(code));
		this.isDuplicate = codes.includes(DUPLICATE_HOSTNAME_CODE) || codes.some((code) => DNS_DUPLICATE_CODES.includes(code));
	}
}

function getToken(env = process.env) {
	return String(env.CLOUDFLARE_API_TOKEN ?? "").trim();
}

export function isCloudflareConfigured(env = process.env) {
	return Boolean(getToken(env));
}

function describe(errors) {
	return errors.map(({ code, message }) => (code ? `${message} (${code})` : message)).join("; ");
}

async function send(method, path, { query, body }) {
	const token = getToken();
	if (!token) throw new CloudflareError("CLOUDFLARE_API_TOKEN isn't set", { status: 401 });
	const url = `${API_URL}${path}${query ? `?${new URLSearchParams(query)}` : ""}`;
	let response;
	try {
		response = await fetch(url, {
			method,
			headers: { authorization: `Bearer ${token}`, ...(body && { "content-type": "application/json" }) },
			...(body && { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (error) {
		const reason = error?.name === "TimeoutError" ? `no answer in ${TIMEOUT_MS / 1000} s` : error.message;
		throw new CloudflareError(`Cloudflare didn't answer ${method} ${path}: ${reason}`, { cause: error });
	}
	const data = await response.json().catch(() => null);
	if (response.ok && data?.success !== false) return data;
	const errors = Array.isArray(data?.errors) ? data.errors : [];
	const detail = describe(errors) || `HTTP ${response.status}`;
	throw new CloudflareError(`Cloudflare refused ${method} ${path}: ${detail}`, {
		status: response.status,
		codes: errors.map(({ code }) => Number(code)).filter(Number.isFinite),
	});
}

async function call(method, path, options = {}) {
	for (let attempt = 0; ; attempt++) {
		try {
			return await send(method, path, options);
		} catch (error) {
			if (!error.isUnavailable || attempt >= RETRY_DELAYS_MS.length) throw error;
			await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
		}
	}
}

// A delete of something already gone is done.
async function remove(path) {
	try {
		await call("DELETE", path);
		return { deleted: true };
	} catch (error) {
		if (error.isNotFound) return { deleted: false };
		throw error;
	}
}

function zonePath(zoneId, rest) {
	if (!zoneId) throw new CloudflareError("No zone ID given", { status: 400 });
	return `/zones/${encodeURIComponent(zoneId)}${rest}`;
}

// Custom hostnames (Cloudflare for SaaS): a customer's hostname, CNAMEd to the SaaS zone, with its certificate.

export async function findCustomHostname(zoneId, hostname) {
	const data = await call("GET", zonePath(zoneId, "/custom_hostnames"), { query: { hostname, per_page: "5" } });
	return (data?.result ?? []).find((item) => item.hostname === hostname) ?? null;
}

export async function getCustomHostname(zoneId, id) {
	try {
		return (await call("GET", zonePath(zoneId, `/custom_hostnames/${encodeURIComponent(id)}`))).result;
	} catch (error) {
		if (error.isNotFound) return null;
		throw error;
	}
}

// One that exists already is returned with existed: true.
export async function createCustomHostname(zoneId, hostname, ssl) {
	try {
		const data = await call("POST", zonePath(zoneId, "/custom_hostnames"), { body: { hostname, ssl } });
		return { ...data.result, existed: false };
	} catch (error) {
		if (!error.isDuplicate && !error.isConflict) throw error;
		const existing = await findCustomHostname(zoneId, hostname);
		if (!existing) throw error;
		return { ...existing, existed: true };
	}
}

// Sending its ssl settings again restarts validation: for a hostname Cloudflare gave up on (moved, timed out).
export async function refreshCustomHostname(zoneId, id, ssl) {
	return (await call("PATCH", zonePath(zoneId, `/custom_hostnames/${encodeURIComponent(id)}`), { body: { ssl } })).result;
}

export function deleteCustomHostname(zoneId, id) {
	return remove(zonePath(zoneId, `/custom_hostnames/${encodeURIComponent(id)}`));
}

// Worker routes on a zone: which Worker serves a pattern like news.example.com/*.

export async function listWorkerRoutes(zoneId) {
	return (await call("GET", zonePath(zoneId, "/workers/routes"))).result ?? [];
}

// A route with the same pattern is returned as it is, with existed: true, whichever Worker it names.
export async function createWorkerRoute(zoneId, { pattern, script }) {
	try {
		const data = await call("POST", zonePath(zoneId, "/workers/routes"), { body: { pattern, script } });
		return { id: data.result?.id, pattern, script, existed: false };
	} catch (error) {
		if (error.isAuth || error.isRateLimited || error.isUnavailable) throw error;
		const existing = (await listWorkerRoutes(zoneId)).find((route) => route.pattern === pattern);
		if (!existing) throw error;
		return { ...existing, existed: true };
	}
}

export function deleteWorkerRoute(zoneId, id) {
	return remove(zonePath(zoneId, `/workers/routes/${encodeURIComponent(id)}`));
}

// DNS records.

export async function listDnsRecords(zoneId, { name, type } = {}) {
	const query = { per_page: "100", ...(name && { name }), ...(type && { type }) };
	return (await call("GET", zonePath(zoneId, "/dns_records"), { query })).result ?? [];
}

// Cloudflare keeps a TXT record's content in quotes, whether it was sent with them or not.
function sameContent(a, b) {
	const unquote = (value) => String(value ?? "").replace(/^"(.*)"$/, "$1");
	return unquote(a) === unquote(b);
}

function isSameRecord(existing, record) {
	return (
		existing.type === record.type &&
		existing.name === record.name &&
		sameContent(existing.content, record.content) &&
		(record.priority === undefined || existing.priority === record.priority)
	);
}

// The same record (type, name, content) existing already is returned with existed: true.
export async function createDnsRecord(zoneId, record) {
	try {
		const data = await call("POST", zonePath(zoneId, "/dns_records"), { body: record });
		return { ...data.result, existed: false };
	} catch (error) {
		if (!error.isDuplicate) throw error;
		const existing = (await listDnsRecords(zoneId, { name: record.name, type: record.type })).find((item) => isSameRecord(item, record));
		if (!existing) throw error;
		return { ...existing, existed: true };
	}
}

export async function updateDnsRecord(zoneId, id, record) {
	return (await call("PATCH", zonePath(zoneId, `/dns_records/${encodeURIComponent(id)}`), { body: record })).result;
}

export function deleteDnsRecord(zoneId, id) {
	return remove(zonePath(zoneId, `/dns_records/${encodeURIComponent(id)}`));
}
