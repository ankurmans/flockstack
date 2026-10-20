// The public pages that look the same to everyone, kept in the data center's cache by worker-entry.mjs so a visitor or a
// crawler doesn't wake the whole app for them. No imports: the Worker's entry loads this before Next.js.
//
// Fresh for FRESH_SECONDS. Past that the stored copy still answers while a new one is fetched behind it, up to
// STALE_SECONDS, so after the first visit nobody waits for the app. The key carries the Worker's version, so a deploy never
// serves an old page that points at the files of an old build.

export const FRESH_SECONDS = 300;
export const STALE_SECONDS = 3600;

const EXACT_PATHS = new Set(["/terms", "/privacy", "/sub-processors", "/robots.txt", "/sitemap.xml", "/llms.txt", "/llms-full.txt", "/llms-docs.txt", "/api/v1/openapi.json"]);
const CACHEABLE_TYPES = /^(text\/(html|plain|xml)|application\/(json|xml))\b/i;
// Headers of Next.js's client navigation and server actions: the same address answers them with something else.
const VARIANT_HEADERS = ["rsc", "next-router-state-tree", "next-router-prefetch", "next-router-segment-prefetch", "next-action", "range", "authorization"];

export function isEdgeCachedPath(pathname) {
	return EXACT_PATHS.has(pathname) || pathname === "/docs" || pathname.startsWith("/docs/");
}

// Only a plain GET of the app's own host (a newsletter's host has its own robots.txt and sitemap.xml, from the database),
// without a query, a session or anything that makes the answer differ.
export function canUseEdgeCache({ method, hostname, appHostname, pathname, search, headers, hasSession }) {
	if (method !== "GET" || hasSession || search) return false;
	if (!appHostname || hostname !== appHostname || !isEdgeCachedPath(pathname)) return false;
	return !VARIANT_HEADERS.some((name) => headers.has(name));
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
export async function serveWithEdgeCache({ request, env, ctx, cache, render, now = Date.now }) {
	const key = edgeCacheKey(new URL(request.url), env);
	const store = async (response) => {
		const stored = new Response(response.body, response);
		stored.headers.set("cache-control", `public, s-maxage=${STALE_SECONDS}`);
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
		if (ageSeconds <= FRESH_SECONDS) return fromCache(hit, "HIT");
		if (ageSeconds <= STALE_SECONDS) {
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
