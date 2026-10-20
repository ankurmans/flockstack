import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FRESH_SECONDS, STALE_SECONDS, canStoreResponse, canUseEdgeCache, edgeCacheKey, isEdgeCachedPath, serveWithEdgeCache } from "../lib/edge-cache.js";

const can = (overrides) => canUseEdgeCache({ method: "GET", hostname: "flockstack.io", appHostname: "flockstack.io", pathname: "/terms", search: "", headers: new Headers(), hasSession: false, ...overrides });

// A cache that keeps what was put, by URL, like caches.default does for responses it may store.
function fakeCache() {
	const entries = new Map();
	return {
		entries,
		match: async (request) => entries.get(request.url)?.clone(),
		put: async (request, response) => void entries.set(request.url, new Response(await response.arrayBuffer(), response)),
	};
}

function setup({ body = "<h1>Terms</h1>", status = 200, headers = {}, env = { CF_VERSION_METADATA: { id: "v1" } } } = {}) {
	const cache = fakeCache();
	const clock = { ms: 1_000_000 };
	const pending = [];
	const calls = [];
	const ctx = { waitUntil: (promise) => pending.push(promise) };
	const render = async (request) => {
		calls.push(request.url);
		return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-cache, no-store", ...headers } });
	};
	const serve = async (url = "https://flockstack.io/terms") => {
		const response = await serveWithEdgeCache({ request: new Request(url), env, ctx, cache, render, now: () => clock.ms });
		const text = await response.text();
		await Promise.all(pending.splice(0));
		return { response, text };
	};
	return { cache, clock, calls, serve };
}

describe("lib/edge-cache.js: which requests may use the cache", () => {
	test("the public pages of the app's own host, and nothing else", () => {
		for (const pathname of ["/terms", "/privacy", "/sub-processors", "/docs", "/docs/api", "/docs/webhooks", "/llms.txt", "/llms-full.txt", "/llms-docs.txt", "/robots.txt", "/sitemap.xml", "/api/v1/openapi.json"]) {
			assert.equal(can({ pathname }), true, pathname);
		}
		for (const pathname of ["/", "/signin", "/docsx", "/campaigns", "/api/v1/contacts", "/api/health", "/mcp", "/archive/x", "/oauth/consent", "/docs-private"]) {
			assert.equal(isEdgeCachedPath(pathname), false, pathname);
		}
	});

	test("not for a session, a query, a method other than GET, another host or a navigation request", () => {
		assert.equal(can({ hasSession: true }), false);
		assert.equal(can({ search: "?utm_source=x" }), false);
		assert.equal(can({ method: "POST" }), false);
		assert.equal(can({ method: "HEAD" }), false);
		assert.equal(can({ hostname: "news.example.com" }), false);
		assert.equal(can({ appHostname: "" }), false);
		for (const name of ["rsc", "next-router-state-tree", "next-router-prefetch", "next-action", "range", "authorization"]) {
			assert.equal(can({ headers: new Headers({ [name]: "1" }) }), false, name);
		}
	});

	test("stores only a 200 of a text type without cookies", () => {
		const response = (status, type, headers = {}) => new Response("x", { status, headers: { "content-type": type, ...headers } });
		assert.equal(canStoreResponse(response(200, "text/html; charset=utf-8")), true);
		assert.equal(canStoreResponse(response(200, "text/plain; charset=utf-8")), true);
		assert.equal(canStoreResponse(response(200, "application/json")), true);
		assert.equal(canStoreResponse(response(200, "application/xml")), true);
		assert.equal(canStoreResponse(response(404, "text/html")), false);
		assert.equal(canStoreResponse(response(307, "text/html")), false);
		assert.equal(canStoreResponse(response(200, "text/html", { "set-cookie": "a=b" })), false);
		assert.equal(canStoreResponse(response(200, "audio/mpeg")), false);
		assert.equal(canStoreResponse(response(200, "")), false);
	});

	test("the key drops the query and carries the Worker's version", () => {
		const a = edgeCacheKey(new URL("https://flockstack.io/terms?x=1"), { CF_VERSION_METADATA: { id: "v1" } });
		const b = edgeCacheKey(new URL("https://flockstack.io/terms"), { CF_VERSION_METADATA: { id: "v2" } });
		assert.equal(a.url, "https://flockstack.io/terms?v=v1");
		assert.notEqual(a.url, b.url);
		assert.equal(edgeCacheKey(new URL("https://flockstack.io/terms"), {}).url, "https://flockstack.io/terms?v=none");
		assert.notEqual(edgeCacheKey(new URL("https://eu.flockstack.io/terms"), {}).url, edgeCacheKey(new URL("https://flockstack.io/terms"), {}).url);
	});
});

describe("lib/edge-cache.js: serving", () => {
	test("the first visit renders and stores, the next ones come from the cache", async () => {
		const { calls, serve } = setup();
		const first = await serve();
		assert.equal(first.response.headers.get("x-edge-cache"), "MISS");
		assert.equal(first.text, "<h1>Terms</h1>");
		const second = await serve();
		assert.equal(second.response.headers.get("x-edge-cache"), "HIT");
		assert.equal(second.text, "<h1>Terms</h1>");
		assert.equal(second.response.headers.get("cache-control"), "public, max-age=0, must-revalidate");
		assert.equal(second.response.headers.get("content-type"), "text/html; charset=utf-8");
		assert.equal(second.response.headers.has("x-edge-stored-at"), false);
		assert.equal(calls.length, 1);
	});

	test("past the fresh time the stored copy answers while a new one is fetched, and once the stale time is up the app answers", async () => {
		const { calls, clock, serve } = setup();
		await serve();
		clock.ms += (FRESH_SECONDS + 1) * 1000;
		const stale = await serve();
		assert.equal(stale.response.headers.get("x-edge-cache"), "STALE");
		assert.equal(calls.length, 2);
		assert.equal((await serve()).response.headers.get("x-edge-cache"), "HIT");
		clock.ms += (STALE_SECONDS + 1) * 1000;
		assert.equal((await serve()).response.headers.get("x-edge-cache"), "MISS");
		assert.equal(calls.length, 3);
	});

	test("a new version of the Worker starts with an empty cache", async () => {
		const first = setup();
		await first.serve();
		const second = { ...setup({ env: { CF_VERSION_METADATA: { id: "v2" } } }) };
		second.cache.entries.set("https://flockstack.io/terms?v=v1", new Response("old"));
		assert.equal((await second.serve()).response.headers.get("x-edge-cache"), "MISS");
	});

	test("an answer that must not be stored goes through untouched and is not stored", async () => {
		for (const options of [{ status: 404 }, { status: 200, headers: { "set-cookie": "a=b; Path=/" } }]) {
			const { cache, serve } = setup(options);
			const { response } = await serve();
			assert.equal(response.headers.get("x-edge-cache"), "BYPASS");
			assert.equal(response.status, options.status);
			assert.equal(response.headers.get("cache-control"), "private, no-cache, no-store");
			assert.equal(cache.entries.size, 0);
		}
	});

	test("a cache that fails never fails the page", async () => {
		const broken = { match: async () => { throw new Error("cache down"); }, put: async () => { throw new Error("cache down"); } };
		const pending = [];
		const response = await serveWithEdgeCache({
			request: new Request("https://flockstack.io/terms"),
			env: {},
			ctx: { waitUntil: (promise) => pending.push(promise) },
			cache: broken,
			render: async () => new Response("ok", { headers: { "content-type": "text/html" } }),
		});
		assert.equal(await response.text(), "ok");
		await Promise.all(pending);
	});
});
