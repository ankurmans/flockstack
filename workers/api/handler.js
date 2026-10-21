// The lean API Worker's routes: the same route modules the Next.js app serves (app/api/v1, app/mcp, app/api/mcp, app/.well-known,
// app/api/auth), called the way Next.js calls them, with no Next.js in between. One implementation: nothing in here knows what
// an action, a key or a token is. Each group's modules load when its first request arrives, so a request for one never
// evaluates the others' code.
//
// workers/api/index.js is the Worker's entry; tests call handleApiRequest directly (tests/api-worker-routes.test.mjs).
import { getApiGroup } from "../../lib/api-routing.js";

const PARAMS = (path) => ({ params: Promise.resolve({ path }) });

// Exact routes win over the catch-all, as in Next.js. `file` is the route's file in app/: tests/api-worker-routes.test.mjs checks
// that this table and the app's files are the same set.
export const API_ROUTES = [
	{ file: "app/api/v1/openapi.json/route.js", group: "rest", match: (path) => path === "/api/v1/openapi.json", load: () => import("../../app/api/v1/openapi.json/route.js") },
	{ file: "app/api/v1/account/export.zip/route.js", group: "rest", match: (path) => path === "/api/v1/account/export.zip", load: () => import("../../app/api/v1/account/export.zip/route.js") },
	{ file: "app/api/v1/contacts/export.csv/route.js", group: "rest", match: (path) => path === "/api/v1/contacts/export.csv", load: () => import("../../app/api/v1/contacts/export.csv/route.js") },
	{
		file: "app/api/v1/[...path]/route.js",
		group: "rest",
		match: (path) => path.startsWith("/api/v1/") || path === "/api/v1",
		params: (path) => PARAMS(path.split("/").slice(3).filter(Boolean).map(decodeURIComponent)),
		load: () => import("../../app/api/v1/[...path]/route.js"),
	},
	{ file: "app/mcp/route.js", group: "mcp", match: (path) => path === "/mcp", load: () => import("../../app/mcp/route.js") },
	{ file: "app/api/mcp/route.js", group: "mcp", match: (path) => path === "/api/mcp", load: () => import("../../app/api/mcp/route.js") },
	{
		file: "app/.well-known/oauth-authorization-server/route.js",
		group: "wellknown",
		match: (path) => path === "/.well-known/oauth-authorization-server",
		load: () => import("../../app/.well-known/oauth-authorization-server/route.js"),
	},
	{
		file: "app/.well-known/oauth-protected-resource/route.js",
		group: "wellknown",
		match: (path) => path === "/.well-known/oauth-protected-resource",
		load: () => import("../../app/.well-known/oauth-protected-resource/route.js"),
	},
	{
		file: "app/.well-known/oauth-protected-resource/mcp/route.js",
		group: "wellknown",
		match: (path) => path === "/.well-known/oauth-protected-resource/mcp",
		load: () => import("../../app/.well-known/oauth-protected-resource/mcp/route.js"),
	},
	{
		file: "app/.well-known/openid-configuration/route.js",
		group: "wellknown",
		match: (path) => path === "/.well-known/openid-configuration",
		load: () => import("../../app/.well-known/openid-configuration/route.js"),
	},
	// Better Auth's routes. Only the endpoints an MCP client calls with no browser are the Worker's (OAUTH_ENDPOINT_PATHS in
	// lib/api-routing.js); the rest of /api/auth is the app's.
	{ file: "app/api/auth/[...all]/route.js", group: "oauth", match: (path) => getApiGroup(path) === "oauth", load: () => import("../../app/api/auth/[...all]/route.js") },
];

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

// What a request that is not the API's gets, marked so the router can hand it to the app (a GET it never body-read).
export function notMine() {
	return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "x-fs-api-miss": "1" } });
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
	let method = request.method;
	if (method === "HEAD" && !handlers.HEAD && handlers.GET) {
		const response = await handlers.GET(request, extra);
		return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
	}
	if (typeof handlers[method] !== "function") {
		if (method === "OPTIONS") {
			return new Response(null, { status: 204, headers: { allow: [...new Set([...allowed, ...(handlers.GET ? ["HEAD"] : []), "OPTIONS"])].join(", ") } });
		}
		return new Response(null, { status: 405, headers: { allow: [...new Set([...allowed, ...(handlers.GET ? ["HEAD"] : []), "OPTIONS"])].join(", ") } });
	}
	return handlers[method](request, extra);
}

export async function handleApiRequest(request) {
	const url = new URL(request.url);
	if (!getApiGroup(url.pathname)) return notMine();
	if (url.pathname.length > 1 && url.pathname.endsWith("/")) return redirectTrailingSlash(request.url);
	const route = API_ROUTES.find((candidate) => candidate.match(url.pathname));
	if (!route) return notMine();
	let extra;
	try {
		extra = route.params?.(url.pathname);
	} catch {
		return new Response("Bad Request", { status: 400 });
	}
	return callRoute(route, request, extra);
}
