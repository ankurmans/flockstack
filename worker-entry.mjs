// The Worker's entry: OpenNext's handler for requests, plus Cloudflare Cron Triggers for the jobs that used to need an
// outside scheduler (app/api/cron). A trigger calls the route through the same handler with CRON_SECRET.
import openNext from "./.open-next/worker.js";
import { isCertificateValidationRequest } from "./lib/certificate-validation.js";
import { EDGE_CACHE_POLICIES, getEdgeCacheKind, serveWithEdgeCache } from "./lib/edge-cache.js";
import { MOUNTED_RESPONSE_HEADER, MOUNTED_SLUG_RESPONSE_HEADER, MOUNT_HEADER, toMountedRequestUrl } from "./lib/mount-rules.js";
import { getCookiePrefix } from "./lib/region.js";
import { unavailableResponse } from "./lib/unavailable-response.js";
import { hasSessionCookie, shouldForwardToWebsite } from "./lib/website-routing.js";

export { BucketCachePurge, DOQueueHandler, DOShardedTagCache } from "./.open-next/worker.js";

// Keep in step with `triggers.crons` in wrangler.jsonc (tests/cron-trigger.test.mjs checks it).
export const CRON_JOBS = {
	"0 * * * *": "/api/cron/hourly",
	"30 6 * * *": "/api/cron/postmaster",
};

// How long the website gets to answer before the app does instead.
const WEBSITE_TIMEOUT_MS = 8000;

// The website's answer, or null where there is none to give: it threw (the binding's Worker is missing or failed to start),
// timed out, or answered that it is unavailable. Only GET and HEAD get here (lib/website-routing.js), so asking again is safe.
async function fetchWebsite(website, request) {
	// The timer covers the wait for the answer, not the reading of it: a page that has started arriving is not cut off.
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), WEBSITE_TIMEOUT_MS);
	try {
		const response = await website.fetch(request, { signal: controller.signal });
		if ([502, 503, 504].includes(response.status)) {
			await response.body?.cancel();
			return null;
		}
		return response;
	} catch (error) {
		console.warn(`[website] fell back to the app: ${error?.message ?? error}`);
		return null;
	} finally {
		clearTimeout(timer);
	}
}

// The app's answer with how long the app took to produce it (server-timing: app;dur=), counted from the request reaching this
// code, so it does not include starting the isolate: a cold request shows the difference against what the router measured around
// the whole call (docs/PERFORMANCE.md). x-served-by names the Worker when no router in front has.
function withTiming(response, startedAt) {
	if (response.status === 101 || response.webSocket) return response;
	const copy = new Response(response.body, response);
	if (!copy.headers.has("x-served-by")) copy.headers.set("x-served-by", "app");
	const timing = copy.headers.get("server-timing");
	copy.headers.set("server-timing", `${timing ? `${timing}, ` : ""}app;dur=${Date.now() - startedAt}`);
	return copy;
}

// What proxy.js marked as mounted goes out with its URLs under the mount path (lib/mount-rewrite.js, loaded only for these).
async function withMount(response, url) {
	const mountPath = response.headers.get(MOUNTED_RESPONSE_HEADER);
	if (!mountPath) return response;
	const { rewriteMountedResponse } = await import("./lib/mount-rewrite.js");
	return rewriteMountedResponse(response, { mountPath, slug: response.headers.get(MOUNTED_SLUG_RESPONSE_HEADER), upstreamOrigin: url.origin });
}

export default {
	fetch: async (incoming, env, ctx) => {
		const startedAt = Date.now();
		if (isCertificateValidationRequest(incoming, env)) return fetch(incoming);
		let request = incoming;
		let url = new URL(request.url);
		// A request forwarded from a subfolder of its owner's site (lib/mount-rules.js). Whether it really is mounted is proxy.js's to
		// say, from the token; this only maps the app's own files and drops a trailing slash.
		const mounted = request.headers.has(MOUNT_HEADER) ? toMountedRequestUrl(url) : null;
		if (mounted) {
			if (mounted.isStatic && env.ASSETS) return env.ASSETS.fetch(new Request(mounted.url, request));
			request = new Request(mounted.url, request);
			url = mounted.url;
		}
		if (url.pathname === "/api/collaboration/socket") return env.COLLABORATION_SOCKET ? env.COLLABORATION_SOCKET.fetch(request) : new Response("Collaborative editing is unavailable", { status: 503 });
		// The marketing website is its own Worker (a private repository), reached through the WEBSITE service binding. It is
		// FlockStack Cloud's: no binding, no APP_URL, no forwarding (a self-hosted server, or a Worker without the binding).
		if (
			env.WEBSITE &&
			env.APP_URL &&
			shouldForwardToWebsite({
				method: request.method,
				hostname: url.hostname,
				appHostname: new URL(env.APP_URL).hostname,
				pathname: url.pathname,
				hasSession: hasSessionCookie(request.headers.get("cookie"), getCookiePrefix(env)),
			})
		) {
			// The website is another Worker: when it is down, slow or missing, the visitor gets the app's answer, not an error.
			const response = await fetchWebsite(env.WEBSITE, request);
			if (response) return response;
		}
		const render = async (req) => {
			try {
				return await openNext.fetch(req, env, ctx);
			} catch (error) {
				console.error(`[app] ${req.method} ${url.pathname} threw:`, error?.message ?? error);
				return unavailableResponse(url.pathname);
			}
		};
		// The public pages that are the same for everyone come from the data center's cache (lib/edge-cache.js), so a crawler's
		// visit doesn't start the app: FlockStack's own docs and files, and a newsletter's public pages on its own host. A Worker
		// on workers.dev has no cache: there the app answers, as before.
		const cacheKind =
			env.APP_URL && typeof caches !== "undefined" && caches.default
				? getEdgeCacheKind({
						method: request.method,
						hostname: url.hostname,
						appHostname: new URL(env.APP_URL).hostname,
						pathname: url.pathname,
						search: url.search,
						headers: request.headers,
						hasSession: hasSessionCookie(request.headers.get("cookie"), getCookiePrefix(env)),
						hasAnalytics: Boolean(String(env.POSTHOG_KEY ?? "").trim()),
					})
				: null;
		if (cacheKind) return withTiming(await serveWithEdgeCache({ request, env, ctx, cache: caches.default, render, policy: EDGE_CACHE_POLICIES[cacheKind] }), startedAt);
		return withTiming(await withMount(await render(request), url), startedAt);
	},

	async scheduled(event, env, ctx) {
		const path = CRON_JOBS[event.cron];
		if (!path) return;
		ctx.waitUntil(
			(async () => {
				const request = new Request(new URL(path, env.APP_URL), { headers: { authorization: `Bearer ${env.CRON_SECRET}` } });
				const response = await openNext.fetch(request, env, ctx);
				console.info(`[cron] ${path} answered ${response.status}`);
			})()
		);
	},
};
