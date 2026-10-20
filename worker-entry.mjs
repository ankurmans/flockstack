// The Worker's entry: OpenNext's handler for requests, plus Cloudflare Cron Triggers for the jobs that used to need an
// outside scheduler (app/api/cron). A trigger calls the route through the same handler with CRON_SECRET.
import openNext from "./.open-next/worker.js";
import { isCertificateValidationRequest } from "./lib/certificate-validation.js";
import { getCookiePrefix } from "./lib/region.js";
import { hasSessionCookie, shouldForwardToWebsite } from "./lib/website-routing.js";

export { BucketCachePurge, DOQueueHandler, DOShardedTagCache } from "./.open-next/worker.js";

// Keep in step with `triggers.crons` in wrangler.jsonc (tests/cron-trigger.test.mjs checks it).
export const CRON_JOBS = {
	"0 * * * *": "/api/cron/hourly",
	"30 6 * * *": "/api/cron/postmaster",
};

export default {
	fetch: (request, env, ctx) => {
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
			return env.WEBSITE.fetch(request);
		}
		return openNext.fetch(request, env, ctx);
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
