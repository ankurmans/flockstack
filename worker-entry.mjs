// The Worker's entry: OpenNext's handler for requests, plus Cloudflare Cron Triggers for the jobs that used to need an
// outside scheduler (app/api/cron). A trigger calls the route through the same handler with CRON_SECRET.
import openNext from "./.open-next/worker.js";
import { isCertificateValidationRequest } from "./lib/certificate-validation.js";
import { EDGE_CACHE_POLICIES, getEdgeCacheKind, serveWithEdgeCache } from "./lib/edge-cache.js";
import { getCookiePrefix } from "./lib/region.js";
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

export default {
	fetch: async (request, env, ctx) => {
		if (isCertificateValidationRequest(request, env)) return fetch(request);
		const url = new URL(request.url);
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
		const render = (req) => openNext.fetch(req, env, ctx);
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
		if (cacheKind) return serveWithEdgeCache({ request, env, ctx, cache: caches.default, render, policy: EDGE_CACHE_POLICIES[cacheKind] });
		return render(request);
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
