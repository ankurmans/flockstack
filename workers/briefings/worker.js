// The briefings Worker's handlers (workers/briefings/index.js is the entry). Tests give createBriefingsWorker a stand-in engine.
import { setBindings, runInRequest } from "../api/shims/runtime.js";

// The engine stops starting stages after this long; a scheduled invocation may run 15 minutes, and a cut-off run resumes next tick.
export const TICK_BUDGET_MS = 5 * 60_000;
export const HEALTH_PATH = "/__briefings/health";

const isOff = (env) => String(env.BRIEFINGS_DISABLED ?? "").toLowerCase() === "true";

// What the engine is given to deliver with: the API Worker's RPC methods, called one by one so each call keeps its stub.
export function apiDelivery(api) {
	return {
		deliverIssue: (payload) => api.deliverIssue(payload),
		notifyOwner: (message) => api.notifyOwner(message),
	};
}

export function createBriefingsWorker({ loadEngine = () => import("../../lib/briefings/index.js") } = {}) {
	return {
		async fetch(request, env) {
			if (new URL(request.url).pathname !== HEALTH_PATH) return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
			const state = isOff(env) ? "off" : !env.DB ? "no database" : !env.API ? "no API binding" : "ok";
			return new Response(`${state}\n`, { status: state === "ok" || state === "off" ? 200 : 503, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-served-by": "briefings" } });
		},

		async scheduled(_event, env, ctx) {
			if (isOff(env)) return { skipped: "switched off" };
			if (!env.DB || !env.API) {
				console.error(`[briefings] not run: ${!env.DB ? "no DB binding" : "no API binding"}`);
				return { skipped: "not configured" };
			}
			setBindings(env);
			return runInRequest(ctx, async () => {
				const { runTick } = await loadEngine();
				const result = await runTick({
					env,
					now: new Date(),
					delivery: apiDelivery(env.API),
					timeBudgetMs: TICK_BUDGET_MS,
					fetchImpl: (...args) => fetch(...args),
					ai: env.AI ?? null,
				});
				console.info(`[briefings] ${JSON.stringify(result)}`);
				return result;
			});
		},
	};
}
