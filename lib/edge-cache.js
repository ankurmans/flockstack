// The public pages that look the same to everyone, kept in the data center's cache by worker-entry.mjs so a visitor or a
// crawler doesn't wake the whole app for them: the app's own pages and files (the docs, the legal pages, robots.txt, the
// OpenAPI document), and the public pages of a newsletter's archive on its own host. No imports: the Worker's entry loads this
// before Next.js.
//
// Fresh for FRESH_SECONDS. Past that the stored copy still answers while a new one is fetched behind it, up to
// STALE_SECONDS, so after the first visit nobody waits for the app. The key carries the Worker's version, so a deploy never
// serves an old page that points at the files of an old build.
//
// There is no purge. The Cache API keeps its own copy in each data center, and nothing here can reach the others: what bounds
// how long an old page can be shown is the stale time, which is why a newsletter's pages (an issue the author unpublishes or
// edits, a new issue on the home page) keep it to ten minutes. The archive's own revalidation after a send (revalidateArchive)
// reaches the app's render, not these copies. A deploy empties them all.

import { VARIANT_HEADERS } from "./public-routing.js";

export const FRESH_SECONDS = 300;
export const STALE_SECONDS = 3600;
export const ARCHIVE_FRESH_SECONDS = 60;
export const ARCHIVE_STALE_SECONDS = 600;

// How long each kind of page stays fresh and may still answer after that: "app" for FlockStack's own host, "archive" for a
// newsletter's.
export const EDGE_CACHE_POLICIES = {
	app: { fresh: FRESH_SECONDS, stale: STALE_SECONDS },
	archive: { fresh: ARCHIVE_FRESH_SECONDS, stale: ARCHIVE_STALE_SECONDS },
};

const EXACT_PATHS = new Set(["/terms", "/privacy", "/sub-processors", "/robots.txt", "/sitemap.xml", "/llms.txt", "/llms-full.txt", "/llms-docs.txt", "/api/v1/openapi.json"]);
const CACHEABLE_TYPES = /^(text\/(html|plain|xml)|application\/(json|xml))\b/i;
// The pages of a newsletter's archive that are the same for everyone who comes without a cookie (proxy.js maps them from the
// newsletter's host to app/archive/[slug]): the home page, the list of issues, an issue, a tag, an author, the links page and
// the files for crawlers and readers' apps. Nothing with a form or a price (subscribe, shop, give, offers), nothing of a
// reader's own (sign-in, account), and no link a mail carries (unsubscribe, confirm, polls, tracking): none is listed.
const ARCHIVE_EXACT_PATHS = new Set(["/", "/issues", "/links", "/sitemap.xml", "/robots.txt", "/llms.txt", "/feed.xml", "/podcast.xml"]);
const ARCHIVE_PATTERNS = [/^\/p\/[a-z0-9][a-z0-9-]{0,119}$/, /^\/tags\/[a-z0-9][a-z0-9-]{0,59}$/, /^\/authors\/[a-z0-9][a-z0-9-]{0,59}$/];
// Cookies Cloudflare itself may set on a visitor, which say nothing about who they are.
const HARMLESS_COOKIES = new Set(["__cf_bm", "_cfuvid", "cf_clearance"]);

export function isEdgeCachedPath(pathname) {
	return EXACT_PATHS.has(pathname) || pathname === "/docs" || pathname.startsWith("/docs/");
}

export function isArchiveCachedPath(pathname) {
	return ARCHIVE_EXACT_PATHS.has(pathname) || ARCHIVE_PATTERNS.some((pattern) => pattern.test(pathname));
}

// Whether a Cookie header carries anything but Cloudflare's own: a session, a reader's cookie, a consent choice.
export function hasOwnCookie(cookieHeader) {
	return String(cookieHeader ?? "")
		.split(";")
		.some((part) => {
			const name = part.split("=")[0].trim();
			return name !== "" && !HARMLESS_COOKIES.has(name);
		});
}

// Which policy a request may use ("app" or "archive"), or null for none.
//  - Only a plain GET, without a query or anything that makes the answer differ.
//  - FlockStack's own host: the pages in isEdgeCachedPath. Where the pages carry the analytics (a POSTHOG_KEY) their HTML is
//    not stored: the server decides per visitor, from their country and privacy signals, whether the consent banner is
//    asked for, so one visitor's page is not another's. The public pages Worker (workers/public) serves those pages with the
//    analytics filled in per request; the files without HTML (robots.txt, sitemap.xml, the OpenAPI document, llms) stay.
//  - Any other host is a newsletter's (Cloudflare for SaaS sends only those here): the pages in isArchiveCachedPath, for a
//    visitor with no cookie of their own, since a session or a reader's cookie can change what a page shows.
export function getEdgeCacheKind({ method, hostname, appHostname, pathname, search, headers, hasSession, hasAnalytics = false }) {
	if (method !== "GET" || hasSession || search) return null;
	if (!appHostname || VARIANT_HEADERS.some((name) => headers.has(name))) return null;
	if (hostname === appHostname) {
		if (!isEdgeCachedPath(pathname)) return null;
		const isHtml = pathname === "/docs" || pathname.startsWith("/docs/") || ["/terms", "/privacy", "/sub-processors"].includes(pathname);
		return hasAnalytics && isHtml ? null : "app";
	}
	if (!isArchiveCachedPath(pathname) || hasOwnCookie(headers.get("cookie"))) return null;
	return "archive";
}

export function canUseEdgeCache(request) {
	return getEdgeCacheKind(request) !== null;
}

export function canStoreResponse(response) {
	if (response.status !== 200 || response.headers.has("set-cookie")) return false;
	return CACHEABLE_TYPES.test(response.headers.get("content-type") ?? "");
}

// The same address with the Worker's version in it. CF_VERSION_METADATA is the version binding (wrangler.jsonc).
export function edgeCacheKey(url, env) {
	const key = new URL(url.origin + url.pathname);
	key.searchParams.set("v", env.CF_VERSION_METADATA?.id ?? "none");
	return new Request(key, { method: "GET" });
}

function withHeader(response, name, value) {
	const copy = new Response(response.body, response);
	copy.headers.set(name, value);
	return copy;
}

// What a visitor gets from the stored copy: the page may be cached by the edge, never by the browser.
function fromCache(hit, state) {
	const copy = withHeader(hit, "x-edge-cache", state);
	copy.headers.set("cache-control", "public, max-age=0, must-revalidate");
	copy.headers.delete("x-edge-stored-at");
	return copy;
}

// Answers from the cache when it can; otherwise render() runs the app and the answer is stored. Never throws because of the
// cache: any failure of it falls back to the app.
export async function serveWithEdgeCache({ request, env, ctx, cache, render, now = Date.now, policy = EDGE_CACHE_POLICIES.app }) {
	const key = edgeCacheKey(new URL(request.url), env);
	const store = async (response) => {
		const stored = new Response(response.body, response);
		stored.headers.set("cache-control", `public, s-maxage=${policy.stale}`);
		stored.headers.set("x-edge-stored-at", String(now()));
		await cache.put(key, stored);
	};
	const refresh = async () => {
		const fresh = await render(new Request(request.url, { method: "GET", headers: request.headers }));
		if (canStoreResponse(fresh)) await store(fresh);
		else await fresh.body?.cancel();
	};

	let hit = null;
	try {
		hit = await cache.match(key);
	} catch {
		hit = null;
	}
	if (hit) {
		const ageSeconds = (now() - Number(hit.headers.get("x-edge-stored-at") ?? 0)) / 1000;
		if (ageSeconds <= policy.fresh) return fromCache(hit, "HIT");
		if (ageSeconds <= policy.stale) {
			ctx.waitUntil(refresh().catch(() => {}));
			return fromCache(hit, "STALE");
		}
	}

	const response = await render(request);
	if (!canStoreResponse(response)) return withHeader(response, "x-edge-cache", "BYPASS");
	const [forCache, forVisitor] = response.body ? response.body.tee() : [null, null];
	ctx.waitUntil(store(new Response(forCache, response)).catch(() => {}));
	return withHeader(new Response(forVisitor, response), "x-edge-cache", "MISS");
}
