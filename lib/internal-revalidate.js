import crypto from "node:crypto";

// The lean API Worker (workers/api) has no Next.js, so when an action there drops a cached page (revalidatePath) it asks the
// app to do it: a POST to /api/internal/revalidate over the APP service binding, signed with a key derived from
// BETTER_AUTH_SECRET (the secret both Workers hold). Nothing here is reachable with a session: the signature is the credential.

export const REVALIDATE_PATH = "/api/internal/revalidate";
export const SIGNATURE_HEADER = "x-fs-signature";
// A request older than this is refused, so a captured one can't be replayed later.
export const MAX_AGE_MS = 5 * 60_000;
const MAX_PATHS = 20;

// The pages the shared code revalidates (lib/archive-data.js, lib/comments.js, lib/scheduling.js, lib/ab-tests.js). Anything else
// is refused, so a signed request can't reach for other pages.
const ALLOWED_PATHS = [/^\/archive\/\[slug\]$/, /^\/archive\/[a-z0-9-]{1,80}\/p\/[a-z0-9-]{1,120}$/, /^\/campaigns$/, /^\/campaigns\/[a-f0-9]{24}$/];
const ALLOWED_TYPES = [undefined, "layout", "page"];

function deriveKey(secret) {
	return crypto.createHmac("sha256", secret).update("flockstack/internal-revalidate/v1").digest();
}

export function signBody(body, secret) {
	return crypto.createHmac("sha256", deriveKey(secret)).update(body).digest("hex");
}

export function verifySignature(body, signature, secret) {
	if (!secret || typeof signature !== "string") return false;
	const expected = Buffer.from(signBody(body, secret));
	const given = Buffer.from(signature);
	return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

// The body for a set of [path, type] pairs.
export function buildRevalidateBody(entries, now = Date.now()) {
	return JSON.stringify({ at: now, paths: entries.map(([path, type]) => (type ? { path, type } : { path })) });
}

// The entries a verified body asks for, or null when it is malformed, too old, or names a page that may not be revalidated.
export function readRevalidateBody(body, now = Date.now()) {
	let parsed;
	try {
		parsed = JSON.parse(body);
	} catch {
		return null;
	}
	if (!parsed || !Number.isFinite(parsed.at) || Math.abs(now - parsed.at) > MAX_AGE_MS) return null;
	if (!Array.isArray(parsed.paths) || parsed.paths.length === 0 || parsed.paths.length > MAX_PATHS) return null;
	const entries = [];
	for (const item of parsed.paths) {
		if (typeof item?.path !== "string" || !ALLOWED_PATHS.some((pattern) => pattern.test(item.path)) || !ALLOWED_TYPES.includes(item.type)) return null;
		entries.push([item.path, item.type]);
	}
	return entries;
}
