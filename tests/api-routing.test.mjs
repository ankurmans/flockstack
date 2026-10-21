import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { API_GROUPS, API_REST_PREFIX, MCP_PATHS, OAUTH_ENDPOINT_PATHS, WELL_KNOWN_PATHS, getApiGroup, isApiPath } from "../lib/api-routing.js";
import { API_ROUTES } from "../workers/api/handler.js";

// The paths the router sends to the API Worker (lib/api-routing.js) are the routes the app has for them, the proxy lets them through
// without a session, and the API Worker's route table is the app's files. One list, checked from every side.
const ROOT = fileURLToPath(new URL("../", import.meta.url));

function routeFiles(dir) {
	const found = [];
	for (const name of readdirSync(join(ROOT, dir))) {
		const path = join(ROOT, dir, name);
		if (statSync(path).isDirectory()) found.push(...routeFiles(join(dir, name)));
		else if (name === "route.js") found.push(relative(ROOT, path));
	}
	return found;
}

// The URL a route file serves, with [x] and [...x] segments as a made-up value.
function toPath(file) {
	return `/${file.replace(/\/route\.js$/, "").replace(/^app\//, "").replace(/\[\.\.\.[^\]]+\]/g, "something/deep").replace(/\[[^\]]+\]/g, "x")}`;
}

const API_FILES = [
	...routeFiles("app/api/v1"),
	...routeFiles("app/mcp"),
	"app/api/mcp/route.js",
	...routeFiles("app/.well-known"),
	"app/api/auth/[...all]/route.js",
];

describe("the API paths and the app's routes", () => {
	test("every route file the API Worker serves is in its table, and every table entry is a file", () => {
		assert.deepEqual(API_ROUTES.map(({ file }) => file).sort(), [...new Set(API_FILES)].sort());
		for (const { file } of API_ROUTES) assert.ok(statSync(join(ROOT, file)).isFile(), file);
	});

	test("every route file under app/api/v1, app/mcp and app/.well-known is a path the router sends to the API", () => {
		for (const file of API_FILES.filter((name) => !name.includes("api/auth"))) {
			assert.ok(isApiPath(toPath(file)), `${file} -> ${toPath(file)}`);
		}
	});

	test("every list names a route of the app, and nothing under /.well-known or /api/auth is claimed by accident", () => {
		const files = new Set(API_FILES.map((file) => toPath(file)));
		for (const path of [...MCP_PATHS, ...WELL_KNOWN_PATHS]) assert.ok(files.has(path), `${path} is a route of the app`);
		for (const path of OAUTH_ENDPOINT_PATHS) assert.ok(path.startsWith("/api/auth/"), path);
		const wellKnownDirs = routeFiles("app/.well-known").map(toPath).sort();
		assert.deepEqual([...WELL_KNOWN_PATHS].sort(), wellKnownDirs, "all of the app's /.well-known routes, and no other path");
		assert.equal(getApiGroup("/.well-known/pki-validation/x.txt"), null, "certificate validation is the app's");
		assert.equal(getApiGroup("/.well-known/acme-challenge/x"), null);
		for (const path of ["/api/auth/oauth2/authorize", "/api/auth/get-session", "/api/auth/callback/google", "/api/auth/sign-out"]) assert.equal(getApiGroup(path), null, path);
	});

	test("every group has paths, and every path has one group", () => {
		const samples = { rest: `${API_REST_PREFIX}/contacts`, mcp: MCP_PATHS[0], wellknown: WELL_KNOWN_PATHS[0], oauth: OAUTH_ENDPOINT_PATHS[0] };
		assert.deepEqual(Object.keys(samples).sort(), [...API_GROUPS].sort());
		for (const [group, path] of Object.entries(samples)) assert.equal(getApiGroup(path), group);
	});

	test("proxy.js lets all of them through without a session", async () => {
		const proxySource = readFileSync(join(ROOT, "proxy.js"), "utf8");
		const block = /const PUBLIC_PATHS = \[([\s\S]*?)\n\];/.exec(proxySource)[1];
		const patterns = [...block.matchAll(/^\t(\/.*\/i?),$/gm)].map(([, text]) => {
			const last = text.lastIndexOf("/");
			return new RegExp(text.slice(1, last), text.slice(last + 1));
		});
		const open = (path) => patterns.some((pattern) => pattern.test(path));
		for (const path of [...MCP_PATHS, ...WELL_KNOWN_PATHS, ...OAUTH_ENDPOINT_PATHS, "/api/v1/contacts", "/api/v1/openapi.json", "/api/internal/revalidate"]) assert.ok(open(path), `${path} is public in proxy.js`);
	});

	test("a path the app serves with the same words in a different place stays with the app", () => {
		for (const path of ["/mcp/extra", "/api/mcpx", "/api/v1x", "/api/v1x/contacts", "/apiv1/contacts", "/oauth/consent", "/.well-known/oauth-protected-resource/other"]) assert.equal(getApiGroup(path), null, path);
	});
});
