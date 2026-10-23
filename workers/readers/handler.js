// The lean readers Worker's routes: the same route modules the Next.js app serves (app/o, app/c, app/api/unsubscribe, app/api/views,
// app/api/visit, app/api/recommendations/impression, app/f, app/api/embed-script), called the way Next.js calls them, with no
// Next.js in between. One implementation: nothing in here knows what a token, a message or a signup is. Each route's module loads when
// its first request arrives, so a request for one never evaluates the others' code.
//
// workers/readers/index.js is the Worker's entry; tests call handleReaderRequest directly (tests/readers-worker.test.mjs).
import { getReaderGroup } from "../../lib/reader-routing.js";

// Exact routes. `file` is the route's file in app/: tests/reader-routing.test.mjs checks that this table, the lists in
// lib/reader-routing.js and the app's files agree.
export const READER_ROUTES = [
	{ file: "app/o/[token]/route.js", group: "tracking", match: (path) => /^\/o\/[^/]+$/.test(path), params: (path) => ({ token: decodeURIComponent(path.slice(3)) }), load: () => import("../../app/o/[token]/route.js") },
	{ file: "app/c/[token]/route.js", group: "tracking", match: (path) => /^\/c\/[^/]+$/.test(path), params: (path) => ({ token: decodeURIComponent(path.slice(3)) }), load: () => import("../../app/c/[token]/route.js") },
	{ file: "app/api/unsubscribe/route.js", group: "unsubscribe", match: (path) => path === "/api/unsubscribe", load: () => import("../../app/api/unsubscribe/route.js") },
	{ file: "app/api/views/route.js", group: "beacons", match: (path) => path === "/api/views", load: () => import("../../app/api/views/route.js") },
	{ file: "app/api/visit/route.js", group: "beacons", match: (path) => path === "/api/visit", load: () => import("../../app/api/visit/route.js") },
	{ file: "app/api/recommendations/impression/route.js", group: "beacons", match: (path) => path === "/api/recommendations/impression", load: () => import("../../app/api/recommendations/impression/route.js") },
	{ file: "app/f/[id]/route.js", group: "forms", match: (path) => /^\/f\/[a-f0-9]{24}$/i.test(path), params: (path) => ({ id: path.slice(3) }), load: () => import("../../app/f/[id]/route.js") },
	// proxy.js rewrites /embed.js to this route on every host.
	{ file: "app/api/embed-script/route.js", group: "forms", match: (path) => path === "/embed.js", load: () => import("../../app/api/embed-script/route.js") },
];

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

// What a request that is not the readers' gets, marked so the router can hand it to the app (a GET it never body-read).
export function notMine() {
	return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "x-fs-readers-miss": "1" } });
}

// A path without its trailing slash, as Next.js's redirect gives it (308, same query).
function redirectTrailingSlash(url) {
	const target = new URL(url);
	target.pathname = target.pathname.replace(/\/+$/, "") || "/";
	return new Response(null, { status: 308, headers: { location: `${target.pathname}${target.search}` } });
}

// Answers the way Next.js does for a method the route has no handler for: OPTIONS lists them, HEAD is the GET without a body.
async function callRoute(route, request, extra) {
	const handlers = await route.load();
	const allowed = METHODS.filter((method) => typeof handlers[method] === "function");
	const allow = () => [...new Set([...allowed, ...(handlers.GET ? ["HEAD"] : []), "OPTIONS"])].join(", ");
	const method = request.method;
	if (method === "HEAD" && !handlers.HEAD && handlers.GET) {
		const response = await handlers.GET(request, extra);
		return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
	}
	if (typeof handlers[method] !== "function") {
		if (method === "OPTIONS") return new Response(null, { status: 204, headers: { allow: allow() } });
		return new Response(null, { status: 405, headers: { allow: allow() } });
	}
	return handlers[method](request, extra);
}

export async function handleReaderRequest(request) {
	const url = new URL(request.url);
	if (!getReaderGroup(url.pathname)) return notMine();
	if (url.pathname.length > 1 && url.pathname.endsWith("/")) return redirectTrailingSlash(request.url);
	const route = READER_ROUTES.find((candidate) => candidate.match(url.pathname));
	if (!route) return notMine();
	let extra;
	try {
		extra = route.params ? { params: Promise.resolve(route.params(url.pathname)) } : undefined;
	} catch {
		return new Response("Bad Request", { status: 400 });
	}
	return callRoute(route, request, extra);
}
