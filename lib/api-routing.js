// The requests FlockStack Cloud's router (workers/router) hands to the lean API Worker (workers/api) instead of the app: the REST API,
// the MCP server and the OAuth endpoints an MCP client calls with no browser. The dashboard, sign-in, consent page, webhooks and
// jobs stay with the app. No imports: the router bundles this module and must stay a few kilobytes, and the API Worker uses it to
// decide what is its own. tests/api-routing.test.mjs keeps these lists equal to the routes the app has.
//
// Exact paths, except /api/v1, whose every route is one handler (app/api/v1/[...path]) that answers an unknown path itself.

export const API_REST_PREFIX = "/api/v1";
export const MCP_PATHS = ["/mcp", "/api/mcp"];
// RFC 8414 and 9728 documents, answered by Better Auth (app/.well-known/*). Nothing else under /.well-known is the API's:
// Cloudflare for SaaS certificate checks (/.well-known/pki-validation, /acme-challenge) are the app's.
export const WELL_KNOWN_PATHS = [
	"/.well-known/oauth-authorization-server",
	"/.well-known/oauth-protected-resource",
	"/.well-known/oauth-protected-resource/mcp",
	"/.well-known/openid-configuration",
];
// What an MCP client calls with no browser: tokens, their introspection and revocation, client registration, the signing keys and
// the user info. Better Auth's routes under /api/auth (app/api/auth/[...all]); the authorize step and sign-in need the browser's
// session and cookies and stay with the app.
export const OAUTH_ENDPOINT_PATHS = [
	"/api/auth/oauth2/token",
	"/api/auth/oauth2/introspect",
	"/api/auth/oauth2/revoke",
	"/api/auth/oauth2/register",
	"/api/auth/oauth2/userinfo",
	"/api/auth/jwks",
];

// The groups an operator can switch on one at a time (API_ENABLED in workers/router).
export const API_GROUPS = ["rest", "mcp", "wellknown", "oauth"];

const MCP_SET = new Set(MCP_PATHS);
const WELL_KNOWN_SET = new Set(WELL_KNOWN_PATHS);
const OAUTH_SET = new Set(OAUTH_ENDPOINT_PATHS);

// Which group a path belongs to, or null. A trailing slash is the same address for Next.js (it redirects), so it is the same here.
export function getApiGroup(pathname) {
	const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
	if (path === API_REST_PREFIX || path.startsWith(`${API_REST_PREFIX}/`)) return "rest";
	if (MCP_SET.has(path)) return "mcp";
	if (WELL_KNOWN_SET.has(path)) return "wellknown";
	if (OAUTH_SET.has(path)) return "oauth";
	return null;
}

export function isApiPath(pathname) {
	return getApiGroup(pathname) !== null;
}

// "all" or "true" (every group), "" or "false" (none), or a list such as "mcp,wellknown". Unknown names are ignored, so a typo
// switches less on, never more.
export function parseEnabledGroups(value) {
	const text = String(value ?? "").trim().toLowerCase();
	if (!text || text === "false" || text === "off" || text === "0") return new Set();
	if (text === "true" || text === "all" || text === "on" || text === "1") return new Set(API_GROUPS);
	return new Set(text.split(/[\s,]+/).filter((name) => API_GROUPS.includes(name)));
}
