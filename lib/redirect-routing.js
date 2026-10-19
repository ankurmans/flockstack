import { connectDb } from "./db.js";
import { normalizeRedirectPath } from "./redirect-paths.js";
import Newsletter from "../models/Newsletter.js";
import Redirect from "../models/Redirect.js";

// proxy.js asks for every path of a newsletter's website that isn't one of its fixed pages, issues included, so answers
// are kept for a minute per instance: whether the website has any redirect at all, then each path's target. A website
// without redirects costs one query a minute; a new rule works within a minute.
const CACHE_TTL_MS = 60_000;
const MAX_CACHED = 5000;
const sites = new Map();
const paths = new Map();

function remember(cache, key, value) {
	if (cache.size >= MAX_CACHED) cache.clear();
	cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
	return value;
}

function recall(cache, key) {
	const hit = cache.get(key);
	return hit && hit.expiresAt > Date.now() ? hit : null;
}

async function findSite(slug) {
	const hit = recall(sites, slug);
	if (hit) return hit.value;
	await connectDb();
	const newsletter = await Newsletter.findOne({ slug }, { _id: 1 }, { crossAccount: true }).lean();
	const hasRedirects = Boolean(newsletter && (await Redirect.exists({ newsletterId: newsletter._id }).setOptions({ crossAccount: true })));
	return remember(sites, slug, hasRedirects ? newsletter._id : null);
}

// Where a request for pathname on the newsletter `slug`'s website goes instead, or null. A failed lookup is no redirect:
// the page answers as it would without one.
export async function findRedirect(slug, pathname) {
	const path = normalizeRedirectPath(pathname);
	if (!slug || !path) return null;
	try {
		const newsletterId = await findSite(slug);
		if (!newsletterId) return null;
		const key = `${slug}\n${path}`;
		const hit = recall(paths, key);
		if (hit) return hit.value;
		const redirect = await Redirect.findOne({ newsletterId, path }, { to: 1 }, { crossAccount: true }).lean();
		return remember(paths, key, redirect?.to ?? null);
	} catch (error) {
		console.error(`[redirects] Could not look up ${slug}${path}: ${error.message}`);
		return null;
	}
}

export function clearRedirectCache() {
	sites.clear();
	paths.clear();
}
