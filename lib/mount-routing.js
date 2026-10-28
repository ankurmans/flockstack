import { getMountPath } from "./mount-rules.js";

// A newsletter's mount changes only when its owner sets, checks, rotates or removes it, so each instance keeps it for a minute,
// as lib/host-routing.js keeps hosts. A token that doesn't match what is kept is looked up again before it is refused: a new token
// works at once, wherever the request lands.
const CACHE_TTL_MS = 60_000;
// A wrong token asks the database again at most this often per newsletter, so random tokens can't make every request a query.
const RECHECK_MS = 5_000;
const MAX_CACHED = 5000;
const cache = new Map();

async function loadMount(slug) {
	// The database layer loads with the first lookup, never for a request that doesn't need one (tests/proxy-imports.test.mjs).
	const [{ connectDb }, { default: Newsletter }] = await Promise.all([import("./db.js"), import("../models/Newsletter.js")]);
	await connectDb();
	const newsletter = await Newsletter.findOne({ slug }, { slug: 1, mount: 1 }, { crossAccount: true }).lean();
	const mount = newsletter?.mount?.url ? newsletter.mount : null;
	if (cache.size >= MAX_CACHED) cache.clear();
	cache.set(slug, { mount, loadedAt: Date.now(), expiresAt: Date.now() + CACHE_TTL_MS });
	return mount;
}

async function findMount(slug, { fresh = false } = {}) {
	const hit = cache.get(slug);
	if (hit && hit.expiresAt > Date.now() && !(fresh && Date.now() - hit.loadedAt > RECHECK_MS)) return hit.mount;
	return loadMount(slug);
}

export function forgetMount(slug) {
	cache.delete(slug);
}

// The verified mount's address, for the 301 from the upstream, or null.
export async function findVerifiedMountUrl(slug) {
	try {
		const mount = await findMount(slug);
		return mount?.verifiedAt ? mount.url : null;
	} catch (error) {
		console.error(`[mount-routing] Could not look up ${slug}: ${error.message}`);
		return null;
	}
}

// { url, path, matched } when the token is the mount's (verified yet or not: the check itself is a mounted request), else null.
export async function matchMount(slug, token) {
	const { matchMountToken } = await import("./mount-tokens.js");
	try {
		let mount = await findMount(slug);
		let matched = matchMountToken(mount, token);
		if (!matched) {
			mount = await findMount(slug, { fresh: true });
			matched = matchMountToken(mount, token);
		}
		return matched ? { url: mount.url, path: getMountPath(mount.url), matched, isVerified: Boolean(mount.verifiedAt) } : null;
	} catch (error) {
		console.error(`[mount-routing] Could not check ${slug}'s token: ${error.message}`);
		return null;
	}
}
