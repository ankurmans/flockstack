// FlockStack Cloud's front door: the Worker that owns flockstack.io (or eu.flockstack.io) and hands each request to the Worker
// that can answer it without a cold start of the whole app. Plain JavaScript with three tiny imports, no Next.js: it starts in
// milliseconds, where the app's Worker (40 MB) needs seconds.
//
//   WEBSITE  the marketing website (lib/website-routing.js: its paths, and "/" for a visitor without a session)
//   PUBLIC   the pages that look the same to everyone, rendered at deploy time (lib/public-routing.js)
//   APP      the region's app Worker, which keeps every route: the dashboard, /api, /mcp, /oauth, webhooks, jobs, uploads
//
// Cloud only: a self-hosted server has none of this and runs from the one app Worker. Newsletters' own domains and the shared
// archive hosts are not routed here either (Cloudflare for SaaS sends them straight to the app Worker, lib/custom-hostnames.js).
// Fail open: when WEBSITE or PUBLIC throws, is slow or answers 502, 503 or 504, the app answers instead, and nothing is lost
// because the app still has every page. docs/ARCHITECTURE-WORKERS.md has the picture.
import { DEFAULT_TIMEOUT_MS, FALLBACK_STATUSES, HEALTH_PATH, chooseRoute } from "./routing.js";

// The Worker's answer, or null where there is none to give: it threw, it did not start answering in time, or it said it is
// unavailable (or, for PUBLIC, that it has no copy of the page). Only GET and HEAD get here, so asking the app next is safe.
async function ask(name, binding, request, timeoutMs) {
	const controller = new AbortController();
	let timer;
	const timeout = new Promise((resolve) => {
		timer = setTimeout(() => {
			controller.abort();
			resolve(null);
		}, timeoutMs);
	});
	try {
		const upstream = new Request(request, { redirect: "manual" });
		const response = await Promise.race([binding.fetch(upstream, { signal: controller.signal }), timeout]);
		if (!response) {
			console.warn(`[router] ${name} did not answer in ${timeoutMs} ms, the app answers`);
			return null;
		}
		if (FALLBACK_STATUSES.includes(response.status) || response.headers.get("x-fs-public-miss")) {
			await response.body?.cancel();
			console.warn(`[router] ${name} answered ${response.status}, the app answers`);
			return null;
		}
		return response;
	} catch (error) {
		console.warn(`[router] ${name} failed, the app answers: ${error?.message ?? error}`);
		return null;
	} finally {
		clearTimeout(timer);
	}
}

// The answer with the Worker that gave it and the time it took, for whoever asks why a page was slow. A WebSocket upgrade
// is passed through as it is: copying it would drop the socket.
function stamp(response, servedBy, startedAt, upstreamMs) {
	if (response.status === 101 || response.webSocket) return response;
	const copy = new Response(response.body, response);
	copy.headers.set("x-served-by", servedBy);
	const timings = [];
	const existing = copy.headers.get("server-timing");
	if (existing) timings.push(existing);
	if (servedBy !== "router") timings.push(`${servedBy};dur=${upstreamMs}`);
	timings.push(`router;dur=${Date.now() - startedAt}`);
	copy.headers.set("server-timing", timings.join(", "));
	return copy;
}

// What a Next.js client gets for data it asked for and will not get from the app (see chooseRoute): not RSC, never stored.
const RSC_ANSWER_HEADERS = { "cache-control": "no-store", vary: "rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch" };

const router = {
	async fetch(request, env) {
		const startedAt = Date.now();
		const url = new URL(request.url);

		if (url.pathname === HEALTH_PATH && (request.method === "GET" || request.method === "HEAD")) {
			return stamp(new Response(request.method === "HEAD" ? null : "ok\n", { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } }), "router", startedAt, 0);
		}

		const route = chooseRoute({ method: request.method, url, headers: request.headers, env });
		if (route === "skip-prefetch") return stamp(new Response(null, { status: 204, headers: RSC_ANSWER_HEADERS }), "router", startedAt, 0);
		if (route === "hard-navigation") {
			return stamp(new Response(request.method === "HEAD" ? null : "<!doctype html><title>FlockStack</title>\n", { headers: { ...RSC_ANSWER_HEADERS, "content-type": "text/html; charset=utf-8" } }), "router", startedAt, 0);
		}
		if (route !== "app") {
			const timeoutMs = Number(env.ROUTER_TIMEOUT_MS) > 0 ? Number(env.ROUTER_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
			const askedAt = Date.now();
			const response = await ask(route, route === "website" ? env.WEBSITE : env.PUBLIC, request, timeoutMs);
			if (response) return stamp(response, route, startedAt, Date.now() - askedAt);
		}

		// The app gets the request itself, not a copy: method, headers, cookies and the body, which is neither read nor buffered
		// here (webhook signatures cover its exact bytes).
		const askedAt = Date.now();
		try {
			return stamp(await env.APP.fetch(request), "app", startedAt, Date.now() - askedAt);
		} catch (error) {
			console.error(`[router] the app failed: ${error?.message ?? error}`);
			return stamp(new Response("The app is not answering. Try again in a moment.\n", { status: 502, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } }), "router", startedAt, 0);
		}
	},
};

export default router;
