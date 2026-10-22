import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import router from "../workers/router/index.js";
import { API_UNPROCESSED_HEADER, MAX_REPLAY_BYTES, chooseRoute } from "../workers/router/routing.js";
import { API_GROUPS, MCP_PATHS, OAUTH_ENDPOINT_PATHS, WELL_KNOWN_PATHS, getApiGroup, parseEnabledGroups } from "../lib/api-routing.js";

// The router's API binding: which requests go to the lean API Worker, when it is switched on, and the rule for what is asked of the
// app when it fails (a request that only reads is asked again; one that may have changed something never is).
const US = { FLOCKSTACK_REGION: "us", APP_URL: "https://flockstack.io" };

function binding(name, respond) {
	const calls = [];
	return {
		name,
		calls,
		async fetch(request, init) {
			calls.push({ request, init });
			return respond ? respond(request, init) : new Response(`from ${name}`, { headers: { "content-type": "text/plain" } });
		},
	};
}

function stack({ api, app, enabled = "all" } = {}) {
	const bindings = { WEBSITE: binding("website"), PUBLIC: binding("public"), APP: binding("app", app), API: binding("api", api) };
	return { ...bindings, env: { ...US, ...bindings, ...(enabled !== null && { API_ENABLED: enabled }) } };
}

const route = (env, url, { method = "GET", headers = {} } = {}) => chooseRoute({ method, url: new URL(url), headers: new Headers(headers), env });
const send = (env, url, init = {}) => router.fetch(new Request(url, { redirect: "manual", ...init }), env);
const APP = "https://flockstack.io";

describe("which requests go to the API Worker", () => {
	test("every API path goes to API, with any method, when it is switched on", () => {
		const { env } = stack();
		const paths = ["/api/v1/contacts", "/api/v1/campaigns/abc/send", "/api/v1/contacts/export.csv", "/api/v1/account/export.zip", ...MCP_PATHS, ...WELL_KNOWN_PATHS, ...OAUTH_ENDPOINT_PATHS];
		for (const path of paths) for (const method of ["GET", "POST", "PATCH", "DELETE", "OPTIONS"]) assert.equal(route(env, `${APP}${path}`, { method }), "api", `${method} ${path}`);
	});

	test("the app keeps what the API Worker does not serve", () => {
		const { env } = stack();
		for (const path of ["/signin", "/api/auth/oauth2/authorize", "/api/auth/sign-in/social", "/api/auth/callback/google", "/oauth/consent", "/.well-known/pki-validation/abc.txt", "/.well-known/acme-challenge/abc", "/.well-known/security.txt", "/api/webhooks/polar", "/api/jobs/send-batch", "/api/health", "/api/cron/hourly", "/api/internal/revalidate", "/mcp-info", "/api/v10", "/api/v1x"]) {
			assert.equal(route(env, `${APP}${path}`, { method: "POST" }), "app", path);
			assert.equal(route(env, `${APP}${path}`), "app", path);
		}
	});

	test("the openapi document stays with PUBLIC for a plain visit, and goes to the API with a key", () => {
		const { env } = stack();
		assert.equal(route(env, `${APP}/api/v1/openapi.json`), "public");
		assert.equal(route(env, `${APP}/api/v1/openapi.json`, { headers: { authorization: "Bearer k" } }), "api");
		assert.equal(route(env, `${APP}/api/v1/openapi.json`, { method: "OPTIONS" }), "api");
	});

	test("without the PUBLIC binding the openapi document is the API's", () => {
		const { env } = stack();
		delete env.PUBLIC;
		assert.equal(route(env, `${APP}/api/v1/openapi.json`), "api");
	});

	test("nothing goes to the API Worker until API_ENABLED switches it on", () => {
		for (const enabled of [null, "", "false", "off", "0", "nonsense"]) {
			const { env } = stack({ enabled });
			assert.equal(route(env, `${APP}/api/v1/contacts`), "app", String(enabled));
			assert.equal(route(env, `${APP}/mcp`, { method: "POST" }), "app", String(enabled));
		}
		const noBinding = { ...US, API_ENABLED: "all" };
		assert.equal(route(noBinding, `${APP}/api/v1/contacts`), "app", "no binding, no API");
	});

	test("groups switch on one at a time", () => {
		const cases = { rest: ["/api/v1/contacts"], mcp: ["/mcp", "/api/mcp"], wellknown: WELL_KNOWN_PATHS, oauth: OAUTH_ENDPOINT_PATHS };
		for (const group of API_GROUPS) {
			const { env } = stack({ enabled: group });
			for (const [other, paths] of Object.entries(cases)) {
				for (const path of paths) assert.equal(route(env, `${APP}${path}`, { method: "POST" }), other === group ? "api" : "app", `${group} on: ${path}`);
			}
		}
		const { env } = stack({ enabled: " MCP , wellknown,bogus" });
		assert.equal(route(env, `${APP}/mcp`, { method: "POST" }), "api");
		assert.equal(route(env, `${APP}/.well-known/oauth-protected-resource`), "api");
		assert.equal(route(env, `${APP}/api/v1/contacts`), "app");
		assert.deepEqual([...parseEnabledGroups("all")].sort(), [...API_GROUPS].sort());
		assert.deepEqual([...parseEnabledGroups("typo")], [], "a typo switches less on, never more");
	});

	test("only the app's own host is routed: a newsletter's domain with /api/v1 stays with the app", () => {
		const { env } = stack();
		assert.equal(route(env, "https://news.example.com/api/v1/contacts"), "app");
		assert.equal(route(env, "https://abc.flockstackmail.com/mcp", { method: "POST" }), "app");
	});

	test("a workers.dev address has a switch of its own, so the API Worker can be tried there while the domain goes to the app", () => {
		const trial = "https://flockstack-router.me.workers.dev/mcp";
		const { env } = stack({ enabled: "all" });
		assert.equal(route(env, trial, { method: "POST" }), "app", "API_ENABLED is the domain's");
		env.API_ENABLED_WORKERS_DEV = "mcp";
		assert.equal(route(env, trial, { method: "POST" }), "api");
		assert.equal(route(env, "https://flockstack-router.me.workers.dev/api/v1/contacts"), "app", "only the groups it names");
		assert.equal(route(env, `${APP}/mcp`, { method: "POST" }), "api", "and the domain keeps its own");
		const off = stack({ enabled: null });
		off.env.API_ENABLED_WORKERS_DEV = "all";
		assert.equal(route(off.env, trial, { method: "POST" }), "api", "the domain can be off while the trial is on");
		assert.equal(route(off.env, `${APP}/mcp`, { method: "POST" }), "app");
	});

	test("trailing slashes and groups agree with the lists", () => {
		assert.equal(getApiGroup("/mcp/"), "mcp");
		assert.equal(getApiGroup("/api/v1/"), "rest");
		assert.equal(getApiGroup("/api/v1"), "rest");
		assert.equal(getApiGroup("/api/v1x"), null);
		assert.equal(getApiGroup("/"), null);
	});
});

describe("passing requests through", () => {
	test("the API Worker gets the request itself, with its exact bytes, and its streaming answer is passed on unread", async () => {
		const bytes = new Uint8Array(Array.from({ length: 3000 }, (_, index) => (index * 11 + 5) % 256));
		let pulled = 0;
		const stream = new ReadableStream({ pull(controller) { pulled++; controller.enqueue(new TextEncoder().encode("data: x\n\n")); if (pulled > 1) controller.close(); } }, { highWaterMark: 0 });
		const { env, API, APP: appBinding } = stack({ api: () => new Response(stream, { headers: { "content-type": "text/event-stream", "mcp-session-id": "s1" } }) });
		const request = new Request(`${APP}/mcp`, { method: "POST", headers: { authorization: "Bearer k", "content-type": "application/json", "content-length": String(bytes.length), "cf-connecting-ip": "203.0.113.4" }, body: bytes, redirect: "manual" });
		const response = await router.fetch(request, env);
		assert.equal(response.headers.get("x-served-by"), "api");
		assert.equal(response.headers.get("content-type"), "text/event-stream");
		assert.match(response.headers.get("server-timing"), /api;dur=\d+, router;dur=\d+/);
		assert.equal(API.calls.length, 1);
		assert.equal(appBinding.calls.length, 0);
		assert.equal(API.calls[0].request, request, "the same Request object");
		assert.equal(API.calls[0].request.headers.get("cf-connecting-ip"), "203.0.113.4");
		assert.equal(pulled, 0, "the router did not read the answer");
		assert.equal((await response.text()).startsWith("data: x"), true);
	});

	test("a CORS preflight is the API Worker's to answer", async () => {
		const { env, API } = stack({ api: () => new Response(null, { status: 204, headers: { "access-control-allow-origin": "*" } }) });
		const response = await send(env, `${APP}/api/v1/contacts`, { method: "OPTIONS", headers: { origin: "https://site.example", "access-control-request-method": "POST" } });
		assert.equal(response.status, 204);
		assert.equal(response.headers.get("access-control-allow-origin"), "*");
		assert.equal(API.calls.length, 1);
	});
});

describe("failing open", () => {
	const failures = {
		throws: () => {
			throw new Error("the Worker is missing");
		},
		rejects: () => Promise.reject(new Error("failed to start")),
		"answers 502": () => new Response("bad gateway", { status: 502 }),
		"answers 503": () => new Response("unavailable", { status: 503 }),
		"answers 504": () => new Response("timeout", { status: 504 }),
		"says it is not its path": () => new Response("Not found", { status: 404, headers: { "x-fs-api-miss": "1" } }),
		"says it did nothing": () => new Response("off", { status: 503, headers: { [API_UNPROCESSED_HEADER]: "1" } }),
	};

	for (const path of ["/api/v1/contacts?limit=5", "/.well-known/oauth-protected-resource", "/mcp"]) {
		for (const [what, failure] of Object.entries(failures)) {
			test(`GET ${path}: when the API Worker ${what}, the app answers`, async () => {
				const { env, API, APP: appBinding } = stack({ api: failure });
				const response = await send(env, `${APP}${path}`, { headers: { authorization: "Bearer k" } });
				assert.equal(await response.text(), "from app");
				assert.equal(response.headers.get("x-served-by"), "app");
				assert.equal(API.calls.length, 1);
				assert.equal(appBinding.calls.length, 1);
				assert.equal(appBinding.calls[0].request.url, `${APP}${path}`);
				assert.equal(appBinding.calls[0].request.headers.get("authorization"), "Bearer k");
			});
		}
	}

	test("a GET the API Worker does not start answering in time is asked of the app too", async () => {
		const { env, APP: appBinding } = stack({ api: () => new Promise(() => {}) });
		env.ROUTER_API_TIMEOUT_MS = "40";
		const response = await send(env, `${APP}/api/v1/contacts`);
		assert.equal(await response.text(), "from app");
		assert.equal(appBinding.calls.length, 1);
	});

	for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
		test(`${method}: a failure of the API Worker is never replayed to the app, and says so in the API's error shape`, async () => {
			for (const failure of [failures.throws, failures.rejects]) {
				const { env, APP: appBinding } = stack({ api: failure });
				const response = await send(env, `${APP}/api/v1/campaigns/abc/send`, { method, headers: { authorization: "Bearer k", "content-type": "application/json" }, body: method === "DELETE" ? undefined : '{"a":1}' });
				assert.equal(response.status, 502);
				assert.equal(response.headers.get("content-type"), "application/json");
				assert.equal(response.headers.get("x-served-by"), "api");
				const body = await response.json();
				assert.deepEqual(Object.keys(body), ["error"]);
				assert.equal(body.error.code, "unavailable");
				assert.equal(appBinding.calls.length, 0, "the app was not asked");
			}
		});
	}

	test("a POST answered 502, 503 or 504 by the API Worker is that answer: the app is not asked", async () => {
		for (const status of [502, 503, 504]) {
			const { env, APP: appBinding } = stack({ api: () => new Response("busy", { status }) });
			const response = await send(env, `${APP}/mcp`, { method: "POST", body: "{}" });
			assert.equal(response.status, status);
			assert.equal(appBinding.calls.length, 0);
		}
	});

	test("a POST the API Worker says it did nothing for goes to the app with the exact bytes of its body", async () => {
		const bytes = new Uint8Array(Array.from({ length: 2048 }, (_, index) => (index * 13 + 1) % 256));
		const { env, API, APP: appBinding } = stack({ api: async (request) => { await request.arrayBuffer(); return new Response("off", { status: 503, headers: { [API_UNPROCESSED_HEADER]: "1" } }); } });
		const request = new Request(`${APP}/api/v1/contacts`, { method: "POST", headers: { authorization: "Bearer k", "content-length": String(bytes.length), "content-type": "application/octet-stream", "webhook-signature": "v1,abc" }, body: bytes, redirect: "manual" });
		const response = await router.fetch(request, env);
		assert.equal(await response.text(), "from app");
		assert.equal(API.calls.length, 1);
		assert.equal(appBinding.calls.length, 1);
		const [{ request: replayed }] = appBinding.calls;
		assert.equal(replayed.headers.get("webhook-signature"), "v1,abc");
		assert.deepEqual(new Uint8Array(await replayed.arrayBuffer()), bytes);
	});

	test("a POST body over the copy limit is not copied: the API Worker's 'did nothing' is returned as it is", async () => {
		const { env, APP: appBinding } = stack({ api: () => new Response("off", { status: 503, headers: { [API_UNPROCESSED_HEADER]: "1" } }) });
		const request = new Request(`${APP}/api/v1/contacts/import`, { method: "POST", headers: { "content-length": String(MAX_REPLAY_BYTES + 1) }, body: "x", redirect: "manual", duplex: "half" });
		const response = await router.fetch(request, env);
		assert.equal(response.status, 503);
		assert.equal(appBinding.calls.length, 0);
	});

	test("with the API Worker off in the router, everything is the app's as before", async () => {
		const { env, API, APP: appBinding } = stack({ enabled: null });
		for (const [method, path] of [["GET", "/api/v1/contacts"], ["POST", "/mcp"], ["POST", "/api/auth/oauth2/token"], ["GET", "/.well-known/oauth-authorization-server"]]) {
			const response = await send(env, `${APP}${path}`, { method, body: method === "POST" ? "{}" : undefined });
			assert.equal(response.headers.get("x-served-by"), "app", path);
		}
		assert.equal(API.calls.length, 0);
		assert.equal(appBinding.calls.length, 4);
	});
});

describe("the API combined with http, www and workers.dev", () => {
	const EU = { FLOCKSTACK_REGION: "eu", APP_URL: "https://eu.flockstack.io" };
	const stackFor = (config) => {
		const { env, ...rest } = stack();
		return { env: { ...env, ...config }, ...rest };
	};

	test("an API call, an MCP call or a token request on http or www is sent on with a 308 and reaches nobody", async () => {
		for (const [config, host] of [[US, "flockstack.io"], [EU, "eu.flockstack.io"]]) {
			for (const [method, path, www] of [["GET", "/api/v1/contacts?limit=2", false], ["POST", "/api/v1/campaigns/abc/send", false], ["POST", "/mcp", false], ["POST", "/api/auth/oauth2/token", false], ["GET", "/.well-known/oauth-protected-resource/mcp", false], ["POST", "/api/v1/contacts", true], ["POST", "/mcp", true]]) {
				const { env, API, APP: appBinding } = stackFor(config);
				const origin = www ? `https://www.${host}` : `http://${host}`;
				const body = method === "POST" ? '{"a":1}' : undefined;
				const response = await send(env, `${origin}${path}`, { method, body, headers: { authorization: "Bearer k", "content-type": "application/json" } });
				assert.equal(response.status, 308, `${method} ${origin}${path}`);
				assert.equal(response.headers.get("location"), `https://${host}${path}`, "the path and query are kept, the method is the client's to keep (308)");
				assert.equal(response.headers.get("cache-control"), method === "GET" ? "public, max-age=3600" : "no-store", "only a read may be remembered");
				assert.equal(API.calls.length + appBinding.calls.length, 0, "nothing was processed, so nothing was lost or sent twice");
			}
		}
	});

	test("the same calls on https at the domain go to the API Worker, with the body untouched", async () => {
		const { env, API } = stack();
		const request = new Request(`${APP}/mcp`, { method: "POST", body: '{"jsonrpc":"2.0"}', headers: { "content-type": "application/json", "content-length": "17" }, redirect: "manual" });
		await router.fetch(request, env);
		assert.equal(API.calls.length, 1);
		assert.equal(API.calls[0].request, request);
	});

	test("certificate checks over http are not redirected", async () => {
		const { env, APP: appBinding } = stack();
		const response = await send(env, "http://flockstack.io/.well-known/acme-challenge/token123");
		assert.equal(response.status, 200);
		assert.equal(appBinding.calls.length, 1);
		assert.equal((await send(env, "http://flockstack.io/.well-known/pki-validation/x.txt")).status, 200);
	});

	test("a router being tried at its own workers.dev address redirects nothing, and the API answers there with noindex", async () => {
		const trial = { FLOCKSTACK_REGION: "us", APP_URL: "https://flockstack-router.me.workers.dev" };
		const { env, API } = stackFor(trial);
		for (const url of ["http://flockstack-router.me.workers.dev/api/v1/contacts", "https://www.flockstack-router.me.workers.dev/api/v1/contacts"]) {
			assert.notEqual((await send(env, url)).status, 308, url);
		}
		const response = await send(env, "https://flockstack-router.me.workers.dev/api/v1/contacts");
		assert.equal(response.headers.get("x-served-by"), "api");
		assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
		assert.ok(API.calls.length >= 1);
		const domain = await send(stack().env, `${APP}/api/v1/contacts`);
		assert.equal(domain.headers.get("x-robots-tag"), null, "the domain is indexable");
	});

	test("www is a custom domain of the US router only: the staged routers and the EU keep their own addresses", () => {
		const strip = (text) => text.replace(/^\s*\/\/.*$/gm, "");
		const config = JSON.parse(strip(readFileSync(new URL("../workers/router/wrangler.jsonc", import.meta.url), "utf8")));
		assert.deepEqual(config.env.us.routes.map(({ pattern }) => pattern), ["flockstack.io", "www.flockstack.io"]);
		assert.ok(config.env.us.routes.every((route) => route.custom_domain));
		assert.deepEqual(config.env.eu.routes.map(({ pattern }) => pattern), ["eu.flockstack.io"], "no www.eu.flockstack.io");
		assert.equal(config.routes, undefined, "the staged US router has no domain");
		assert.equal(config.env["eu-staged"].routes, undefined);
	});
});
