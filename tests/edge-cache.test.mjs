import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	ARCHIVE_FRESH_SECONDS,
	ARCHIVE_STALE_SECONDS,
	EDGE_CACHE_POLICIES,
	FRESH_SECONDS,
	STALE_SECONDS,
	canStoreResponse,
	canUseEdgeCache,
	edgeCacheKey,
	getEdgeCacheKind,
	hasOwnCookie,
	isArchiveCachedPath,
	isEdgeCachedPath,
	serveWithEdgeCache,
} from "../lib/edge-cache.js";

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
		assert.equal(canStoreResponse(response(200, "application/rss+xml; charset=utf-8")), true, "a newsletter's feed");
		assert.equal(canStoreResponse(response(200, "application/atom+xml")), true);
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

const kind = (overrides) => getEdgeCacheKind({ method: "GET", hostname: "flockstack.io", appHostname: "flockstack.io", pathname: "/terms", search: "", headers: new Headers(), hasSession: false, ...overrides });
const archive = (overrides) => kind({ hostname: "news.example.com", pathname: "/", ...overrides });

describe("lib/edge-cache.js: a newsletter's public pages on its own host", () => {
	test("the pages everyone sees the same, and none that has a form, a price, a reader's own or a mailed link", () => {
		for (const pathname of ["/", "/issues", "/links", "/sitemap.xml", "/robots.txt", "/llms.txt", "/feed.xml", "/podcast.xml", "/p/an-issue.md", "/p/an-issue", "/p/issue-2024-1", "/tags/news", "/authors/ana"]) {
			assert.equal(archive({ pathname }), "archive", pathname);
			assert.equal(isArchiveCachedPath(pathname), true, pathname);
		}
		for (const pathname of ["/subscribe", "/shop", "/shop/a-product", "/give", "/offer/CODE12", "/signin", "/account", "/unsubscribe", "/confirm", "/keep", "/reader/in", "/poll", "/survey", "/preferences", "/pledge", "/gift", "/o/token", "/c/token", "/api/views", "/api/visit", "/api/unsubscribe", "/embed/0123456789abcdef01234567", "/f/0123456789abcdef01234567", "/audio/an-issue.mp3", "/p/", "/p/UPPER", "/p/a/b", "/tags", "/authors", "/_next/static/a.js", "/favicon.ico", "/docs", "/terms", "/api/v1/contacts", "/archive/news"]) {
			assert.equal(archive({ pathname }), null, pathname);
		}
	});

	test("only for a visitor with no cookie of their own, no query and a plain GET", () => {
		assert.equal(archive({ headers: new Headers({ cookie: "__cf_bm=abc; _cfuvid=def; cf_clearance=ghi" }) }), "archive");
		for (const cookie of ["fs_reader_news=abc", "fs_reader_news_on=1", "better-auth.session_token=x", "__Secure-flockstack-eu.session_token=x", "fs_consent=accepted", "other=1", "__cf_bm=abc; fs_reader_news=abc"]) {
			assert.equal(archive({ headers: new Headers({ cookie }) }), null, cookie);
		}
		assert.equal(hasOwnCookie(""), false);
		assert.equal(hasOwnCookie(null), false);
		assert.equal(hasOwnCookie("a=1"), true);
		assert.equal(archive({ search: "?ref=abc" }), null);
		assert.equal(archive({ search: "?page=2" }), null);
		assert.equal(archive({ method: "POST" }), null);
		assert.equal(archive({ method: "HEAD" }), null);
		assert.equal(archive({ hasSession: true }), null);
		for (const name of ["rsc", "next-router-prefetch", "next-action", "range", "authorization"]) assert.equal(archive({ headers: new Headers({ [name]: "1" }) }), null, name);
		assert.equal(archive({ appHostname: "" }), null);
	});

	test("never on FlockStack's own host as an archive, nor FlockStack's pages on a newsletter's host", () => {
		assert.equal(kind({ hostname: "flockstack.io", pathname: "/p/an-issue" }), null);
		assert.equal(kind({ hostname: "flockstack.io", pathname: "/" }), null);
		assert.equal(kind({ hostname: "flockstack.io", pathname: "/docs/api" }), "app");
		assert.equal(archive({ pathname: "/docs/api" }), null);
		assert.equal(archive({ pathname: "/terms" }), null);
	});

	test("stays fresh for a minute and may answer for ten more, and the plan's numbers are the app's own for FlockStack's pages", () => {
		assert.deepEqual(EDGE_CACHE_POLICIES.archive, { fresh: ARCHIVE_FRESH_SECONDS, stale: ARCHIVE_STALE_SECONDS });
		assert.deepEqual(EDGE_CACHE_POLICIES.app, { fresh: FRESH_SECONDS, stale: STALE_SECONDS });
		assert.equal(ARCHIVE_FRESH_SECONDS, 60);
		assert.equal(ARCHIVE_STALE_SECONDS, 600);
	});

	test("an issue is stored for the archive's short time, and the key keeps the newsletter's host apart", async () => {
		const { cache, clock, calls, serve } = setup({ body: "<h1>An issue</h1>", env: { CF_VERSION_METADATA: { id: "v1" } } });
		const serveArchive = async (url) => {
			const pending = [];
			const response = await serveWithEdgeCache({ request: new Request(url), env: { CF_VERSION_METADATA: { id: "v1" } }, ctx: { waitUntil: (promise) => pending.push(promise) }, cache, render: async (request) => { calls.push(request.url); return new Response("<h1>An issue</h1>", { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-cache, no-store" } }); }, now: () => clock.ms, policy: EDGE_CACHE_POLICIES.archive });
			const text = await response.text();
			await Promise.all(pending);
			return { response, text };
		};
		void serve;
		assert.equal((await serveArchive("https://news.example.com/p/an-issue")).response.headers.get("x-edge-cache"), "MISS");
		assert.equal((await serveArchive("https://news.example.com/p/an-issue")).response.headers.get("x-edge-cache"), "HIT");
		assert.equal((await serveArchive("https://other.example.com/p/an-issue")).response.headers.get("x-edge-cache"), "MISS", "another newsletter's host is another key");
		clock.ms += (ARCHIVE_FRESH_SECONDS + 1) * 1000;
		assert.equal((await serveArchive("https://news.example.com/p/an-issue")).response.headers.get("x-edge-cache"), "STALE");
		clock.ms += (ARCHIVE_STALE_SECONDS + 1) * 1000;
		assert.equal((await serveArchive("https://news.example.com/p/an-issue")).response.headers.get("x-edge-cache"), "MISS", "past ten minutes the app answers again");
		const stored = [...cache.entries.values()][0];
		assert.equal(stored.headers.get("cache-control"), `public, s-maxage=${ARCHIVE_STALE_SECONDS}`);
	});

	test("a page of an unpublished or missing issue (404), a redirect and an answer that sets a cookie are never stored", async () => {
		for (const [status, headers] of [[404, {}], [301, {}], [307, {}], [500, {}], [200, { "set-cookie": "fs_reader_news=x; Path=/" }]]) {
			const { cache, serve } = setup({ status, headers });
			const { response } = await serve("https://news.example.com/p/gone");
			assert.equal(response.headers.get("x-edge-cache"), "BYPASS", String(status));
			assert.equal(cache.entries.size, 0);
		}
	});
});

describe("lib/edge-cache.js: pages that carry the analytics", () => {
	test("the HTML of the docs and the legal pages is not stored where a POSTHOG_KEY is set, the files are", () => {
		for (const pathname of ["/docs", "/docs/api", "/terms", "/privacy", "/sub-processors"]) {
			assert.equal(kind({ pathname, hasAnalytics: true }), null, pathname);
			assert.equal(kind({ pathname, hasAnalytics: false }), "app", `${pathname} without analytics`);
		}
		for (const pathname of ["/robots.txt", "/sitemap.xml", "/llms.txt", "/llms-full.txt", "/llms-docs.txt", "/api/v1/openapi.json"]) {
			assert.equal(kind({ pathname, hasAnalytics: true }), "app", pathname);
		}
	});
});

describe("lib/edge-cache.js: a feed reader that already has the copy", () => {
	function feedSetup() {
		const cache = fakeCache();
		const pending = [];
		const calls = [];
		const clock = { ms: 5_000_000 };
		const serve = async (headers = {}) => {
			const response = await serveWithEdgeCache({
				request: new Request("https://news.example.com/feed.xml", { headers }),
				env: { CF_VERSION_METADATA: { id: "v1" } },
				ctx: { waitUntil: (promise) => pending.push(promise) },
				cache,
				render: async () => {
					calls.push(1);
					return new Response("<rss/>", { headers: { "content-type": "application/rss+xml; charset=utf-8", etag: '"abc"', "last-modified": "Tue, 20 Oct 2026 10:00:00 GMT", "access-control-allow-origin": "*" } });
				},
				now: () => clock.ms,
				policy: EDGE_CACHE_POLICIES.archive,
			});
			const text = await response.text();
			await Promise.all(pending.splice(0));
			return { response, text };
		};
		return { calls, serve };
	}

	test("is told it has it, with no body, and a reader without it gets the feed", async () => {
		const { calls, serve } = feedSetup();
		assert.equal((await serve()).response.headers.get("x-edge-cache"), "MISS");
		const full = await serve();
		assert.equal(full.response.status, 200);
		assert.equal(full.text, "<rss/>");
		assert.equal(full.response.headers.get("etag"), '"abc"');
		const same = await serve({ "if-none-match": '"abc"' });
		assert.equal(same.response.status, 304);
		assert.equal(same.text, "");
		assert.equal(same.response.headers.get("etag"), '"abc"');
		assert.equal(same.response.headers.get("x-edge-cache"), "HIT");
		assert.equal(same.response.headers.get("access-control-allow-origin"), "*");
		assert.equal((await serve({ "if-none-match": 'W/"abc", "other"' })).response.status, 304);
		assert.equal((await serve({ "if-none-match": '"stale"' })).response.status, 200);
		assert.equal(calls.length, 1, "the app rendered the feed once");
	});
});
