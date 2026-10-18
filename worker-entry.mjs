// The Worker's entry: OpenNext's handler for requests, plus Cloudflare Cron Triggers for the jobs that used to need an
// outside scheduler (app/api/cron). A trigger calls the route through the same handler with CRON_SECRET.
import openNext from "./.open-next/worker.js";

export { BucketCachePurge, DOQueueHandler, DOShardedTagCache } from "./.open-next/worker.js";

// Keep in step with `triggers.crons` in wrangler.jsonc (tests/cron-trigger.test.mjs checks it).
export const CRON_JOBS = {
	"0 * * * *": "/api/cron/hourly",
	"30 6 * * *": "/api/cron/postmaster",
};

export default {
	fetch: (request, env, ctx) => openNext.fetch(request, env, ctx),

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
