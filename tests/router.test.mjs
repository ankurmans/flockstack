import assert from "node:assert/strict";
import { describe, test } from "node:test";
import router from "../workers/router/index.js";
import { DEFAULT_TIMEOUT_MS, HEALTH_PATH, chooseRoute } from "../workers/router/routing.js";
import { PUBLIC_EXACT_PATHS } from "../lib/public-routing.js";
import { WEBSITE_EXACT_PATHS, WEBSITE_PREFIXES } from "../lib/website-routing.js";

// workers/router: the Worker that owns flockstack.io and hands each request to WEBSITE, PUBLIC or APP. The three bindings are
// stand-ins that record what they were asked, so the table, the fail-open rules and the pass-through are all run without Cloudflare.
const US = { FLOCKSTACK_REGION: "us", APP_URL: "https://flockstack.io" };
const EU = { FLOCKSTACK_REGION: "eu", APP_URL: "https://eu.flockstack.io" };

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

function stack(config = US, overrides = {}) {
	const bindings = { WEBSITE: binding("website", overrides.website), PUBLIC: binding("public", overrides.public), APP: binding("app", overrides.app) };
	return { ...bindings, env: { ...config, ...bindings, ...overrides.env } };
}

const get = (url, headers) => new Request(url, { headers, redirect: "manual" });
const route = (env, url, { method = "GET", headers = {} } = {}) => chooseRoute({ method, url: new URL(url), headers: new Headers(headers), env });
const SESSION_US = { cookie: "better-auth.session_token=abc.def" };
const SESSION_EU = { cookie: "__Secure-flockstack-eu.session_token=abc.def" };

describe("the routing table", () => {
	test("every path the website serves goes to WEBSITE, signed in or out", () => {
		const { env } = stack();
		const samples = [...WEBSITE_EXACT_PATHS, ...WEBSITE_PREFIXES.map((prefix) => `${prefix}something`)];
		assert.ok(samples.length > 20);
		for (const path of samples) {
			assert.equal(route(env, `https://flockstack.io${path}`), "website", path);
			assert.equal(route(env, `https://flockstack.io${path}`, { headers: SESSION_US }), "website", `${path} signed in`);
		}
	});

	test("every public page and file goes to PUBLIC", () => {
		const { env } = stack();
		assert.ok(PUBLIC_EXACT_PATHS.length >= 30);
		for (const path of PUBLIC_EXACT_PATHS) {
			assert.equal(route(env, `https://flockstack.io${path}`), "public", path);
			assert.equal(route(env, `https://flockstack.io${path}`, { headers: SESSION_US }), "public", `${path} signed in`);
			assert.equal(route(env, `https://flockstack.io${path}?utm_source=x`), "public", `${path} with a query`);
		}
	});

	test("/ is the website for a visitor and the app (the dashboard) for a signed-in person", () => {
		const { env } = stack();
		assert.equal(route(env, "https://flockstack.io/"), "website");
		assert.equal(route(env, "https://flockstack.io/", { headers: { cookie: "fs_consent=accepted; theme=dark" } }), "website");
		assert.equal(route(env, "https://flockstack.io/", { headers: SESSION_US }), "app");
		assert.equal(route(env, "https://flockstack.io/", { headers: { cookie: "__Secure-better-auth.session_token=x" } }), "app");
	});

	test("the EU router reads the EU session cookie and not the US one", () => {
		const { env } = stack(EU);
		assert.equal(route(env, "https://eu.flockstack.io/"), "website");
		assert.equal(route(env, "https://eu.flockstack.io/", { headers: SESSION_EU }), "app");
		assert.equal(route(env, "https://eu.flockstack.io/", { headers: { cookie: "flockstack-eu.session_token=x" } }), "app");
		assert.equal(route(env, "https://eu.flockstack.io/", { headers: SESSION_US }), "website", "a US cookie is not an EU session");
		const us = stack(US).env;
		assert.equal(route(us, "https://flockstack.io/", { headers: SESSION_EU }), "website", "an EU cookie is not a US session");
	});

	test("everything else goes to APP", () => {
		const { env } = stack();
		const paths = ["/signin", "/oauth/consent", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp", "/mcp", "/api/mcp", "/api/health", "/api/v1/contacts", "/api/v1/openapi.jsonx", "/api/auth/sign-in/email", "/api/webhooks/polar", "/api/webhooks/payments", "/api/jobs/send-batch", "/api/cron/hourly", "/api/uploads/files", "/api/support/chat", "/campaigns", "/billing", "/admin", "/custom", "/recommendations", "/archive/news", "/p/an-issue", "/unsubscribe", "/confirm", "/o/token", "/c/token", "/reader/signin", "/embed.js", "/_next/static/chunks/a.js", "/favicon.ico", "/icon-192.png", "/opengraph-image", "/docs/", "/docs/nope", "/docs/api/extra", "/terms/", "/llms-docsx.txt", "/home", "/pricing/extra", "/blogger", "/__router/other"];
		for (const path of paths) assert.equal(route(env, `https://flockstack.io${path}`), "app", path);
	});

	test("writes go to APP, even to a page or a path the website or PUBLIC serves", () => {
		const { env } = stack();
		for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
			for (const path of ["/pricing", "/", "/docs", "/terms", "/api/v1/openapi.json", "/llms.txt", "/custom"]) assert.equal(route(env, `https://flockstack.io${path}`, { method }), "app", `${method} ${path}`);
		}
		assert.equal(route(env, "https://flockstack.io/docs", { method: "HEAD" }), "public");
		assert.equal(route(env, "https://flockstack.io/pricing", { method: "HEAD" }), "website");
	});

	test("server actions, ranges and credentials for a public path are the app's to answer", () => {
		const { env } = stack();
		for (const header of ["next-action", "range", "authorization"]) {
			assert.equal(route(env, "https://flockstack.io/docs/api", { headers: { [header]: "1" } }), "app", header);
			assert.equal(route(env, "https://flockstack.io/docs/api", { headers: { [header]: "1", rsc: "1" } }), header === "next-action" ? "app" : "hard-navigation", `${header} with rsc`);
		}
	});

	test("Next.js asks for the data of a page PUBLIC or the website serves: prefetches are dropped, clicks become page loads", () => {
		const { env } = stack();
		const rsc = { rsc: "1", "next-url": "/signin" };
		for (const path of ["/docs/api", "/terms", "/pricing", "/blog/a-post", "/llms.txt"]) {
			assert.equal(route(env, `https://flockstack.io${path}?_rsc=x`, { headers: { ...rsc, "next-router-prefetch": "1" } }), "skip-prefetch", `${path} prefetch`);
			assert.equal(route(env, `https://flockstack.io${path}?_rsc=x`, { headers: { ...rsc, "next-router-segment-prefetch": "/_tree" } }), "skip-prefetch", `${path} segment prefetch`);
			assert.equal(route(env, `https://flockstack.io${path}?_rsc=x`, { headers: rsc }), "hard-navigation", `${path} click`);
		}
		assert.equal(route(env, "https://flockstack.io/?_rsc=x", { headers: { ...rsc, "next-router-prefetch": "1" } }), "skip-prefetch", "/ is the website for a visitor");
		assert.equal(route(env, "https://flockstack.io/?_rsc=x", { headers: { ...rsc, "next-router-prefetch": "1", ...SESSION_US } }), "app", "and the dashboard for a signed-in person");
	});

	test("a docs page's prefetches never reach the app, whatever they are for; a click on the app's own page does", () => {
		const { env } = stack();
		const from = (path, extra) => ({ rsc: "1", "next-url": path, ...extra });
		for (const target of ["/signin", "/billing", "/privacy", "/docs/mcp"]) {
			assert.equal(route(env, `https://flockstack.io${target}?_rsc=x`, { headers: from("/docs/errors", { "next-router-prefetch": "1" }) }), "skip-prefetch", target);
		}
		assert.equal(route(env, "https://flockstack.io/signin?_rsc=x", { headers: from("/docs/errors") }), "app", "a click on Sign in is the app's");
		assert.equal(route(env, "https://flockstack.io/signin?_rsc=x", { headers: from("/campaigns", { "next-router-prefetch": "1" }) }), "app", "the dashboard's own prefetches are the app's");
		assert.equal(route(env, "https://flockstack.io/campaigns?_rsc=x", { headers: from("/billing") }), "app");
		assert.equal(route(env, "https://flockstack.io/signin?_rsc=x", { headers: { rsc: "1", "next-router-prefetch": "1", "next-url": "https://flockstack.io/terms" } }), "skip-prefetch", "next-url as an address");
	});

	test("without PUBLIC or the website bound, Next.js data requests go to the app as before", () => {
		const bare = { ...US, APP: {} };
		assert.equal(route(bare, "https://flockstack.io/docs?_rsc=x", { headers: { rsc: "1" } }), "app");
		assert.equal(route(bare, "https://flockstack.io/pricing?_rsc=x", { headers: { rsc: "1", "next-router-prefetch": "1" } }), "app");
	});

	test("another host never leaves APP: a newsletter's own domain, the shared archive hosts, another region's address", () => {
		const { env } = stack();
		for (const host of ["news.example.com", "eu.flockstack.io", "sites.flockstack.io", "newsletter.ankur.works", "flockstack.io.example.com", "notflockstack.io", "a.workers.dev.example.com"]) {
			for (const path of ["/", "/pricing", "/docs", "/terms", "/blog"]) assert.equal(route(env, `https://${host}${path}`), "app", `${host}${path}`);
		}
	});

	test("a workers.dev address is routed like the domain, so a router can be tried before a domain moves to it", () => {
		const { env } = stack();
		const host = "flockstack-router.example.workers.dev";
		assert.equal(route(env, `https://${host}/pricing`), "website");
		assert.equal(route(env, `https://${host}/`), "website");
		assert.equal(route(env, `https://${host}/`, { headers: SESSION_US }), "app");
		assert.equal(route(env, `https://${host}/docs/api`), "public");
		assert.equal(route(env, `https://${host}/signin`), "app");
		assert.equal(route(env, `https://${host}/docs/api?_rsc=x`, { headers: { rsc: "1" } }), "hard-navigation");
	});

	test("a router without a binding or without APP_URL sends everything to APP", () => {
		assert.equal(route({ ...US, APP: {} }, "https://flockstack.io/pricing"), "app");
		assert.equal(route({ ...US, APP: {}, WEBSITE: {} }, "https://flockstack.io/docs"), "app");
		assert.equal(route({ ...US, APP: {}, PUBLIC: {} }, "https://flockstack.io/"), "app");
		const { env } = stack();
		assert.equal(route({ ...env, APP_URL: "" }, "https://flockstack.io/pricing"), "app");
	});
});

describe("answering", () => {
	test("answers a dropped prefetch with 204 and a click on a served page with something Next.js cannot read as data", async () => {
		const { env, APP, PUBLIC, WEBSITE } = stack();
		const prefetch = await router.fetch(get("https://flockstack.io/docs/api?_rsc=x", { rsc: "1", "next-router-prefetch": "1", "next-url": "/docs" }), env);
		assert.equal(prefetch.status, 204);
		assert.equal(prefetch.headers.get("x-served-by"), "router");
		assert.equal(prefetch.headers.get("cache-control"), "no-store");
		const click = await router.fetch(get("https://flockstack.io/terms?_rsc=x", { rsc: "1", "next-url": "/docs" }), env);
		assert.equal(click.status, 200);
		assert.match(click.headers.get("content-type"), /^text\/html/);
		assert.equal(click.headers.get("cache-control"), "no-store");
		assert.doesNotMatch(click.headers.get("content-type"), /x-component/);
		assert.equal(APP.calls.length + PUBLIC.calls.length + WEBSITE.calls.length, 0, "nothing was asked");
	});

	test("sends the visit to the Worker that serves it and says which one answered", async () => {
		for (const [path, name] of [["/pricing", "website"], ["/", "website"], ["/docs/api", "public"], ["/terms", "public"], ["/signin", "app"], ["/api/v1/contacts", "app"]]) {
			const { env, ...rest } = stack();
			const response = await router.fetch(get(`https://flockstack.io${path}`), env);
			assert.equal(await response.text(), `from ${name}`, path);
			assert.equal(response.headers.get("x-served-by"), name, path);
			assert.match(response.headers.get("server-timing"), new RegExp(`(^|, )router;dur=\\d+`), path);
			if (name !== "app") assert.match(response.headers.get("server-timing"), new RegExp(`${name};dur=\\d+`), path);
			const asked = rest[name.toUpperCase()].calls;
			assert.equal(asked.length, 1, `${name} asked once`);
			for (const other of ["WEBSITE", "PUBLIC", "APP"]) if (other !== name.toUpperCase()) assert.equal(rest[other].calls.length, 0, `${other} not asked for ${path}`);
		}
	});

	test("keeps what the Worker answered: status, headers, cookies and a stream it never reads", async () => {
		let pulled = 0;
		const body = new ReadableStream({
			pull(controller) {
				pulled++;
				controller.enqueue(new TextEncoder().encode("chunk"));
				if (pulled === 1) return;
				controller.close();
			},
		}, { highWaterMark: 0 });
		const headers = new Headers({ "content-type": "text/event-stream", location: "https://flockstack.io/x", "cf-cache-status": "DYNAMIC", "server-timing": "app;dur=3" });
		headers.append("set-cookie", "a=1; Path=/; HttpOnly");
		headers.append("set-cookie", "b=2; Path=/; Secure");
		const { env } = stack(US, { app: () => new Response(body, { status: 302, headers }) });
		const response = await router.fetch(get("https://flockstack.io/api/auth/callback"), env);
		assert.equal(response.status, 302);
		assert.equal(response.headers.get("location"), "https://flockstack.io/x");
		assert.deepEqual(response.headers.getSetCookie(), ["a=1; Path=/; HttpOnly", "b=2; Path=/; Secure"]);
		assert.equal(response.headers.get("cf-cache-status"), "DYNAMIC");
		assert.match(response.headers.get("server-timing"), /^app;dur=3, app-wait;dur=\d+, router;dur=\d+$/, "the app timed its own handler; the router timed the wait");
		assert.equal(pulled, 0, "the router did not read the body");
		assert.equal((await response.text()).startsWith("chunk"), true);
	});

	test("hands APP the request itself: method, headers, cookies, cf headers and the exact bytes of the body", async () => {
		const bytes = new Uint8Array(Array.from({ length: 4096 }, (_, index) => (index * 7 + 3) % 256));
		const { env, APP } = stack();
		const request = new Request("https://flockstack.io/api/webhooks/polar?x=1", {
			method: "POST",
			headers: { "content-type": "application/json", "webhook-id": "msg_1", "webhook-timestamp": "1700000000", "webhook-signature": "v1,abc=", "stripe-signature": "t=1,v1=abc", cookie: "better-auth.session_token=x; fs_consent=accepted", "cf-connecting-ip": "203.0.113.9", "cf-ipcountry": "DE", "x-forwarded-for": "203.0.113.9" },
			body: bytes,
			redirect: "manual",
		});
		await router.fetch(request, env);
		assert.equal(APP.calls.length, 1);
		const [{ request: forwarded }] = APP.calls;
		assert.equal(forwarded, request, "the same Request object, not a copy");
		assert.equal(forwarded.method, "POST");
		assert.equal(forwarded.url, "https://flockstack.io/api/webhooks/polar?x=1");
		for (const name of ["webhook-signature", "stripe-signature", "cf-connecting-ip", "cf-ipcountry", "cookie", "x-forwarded-for"]) assert.ok(forwarded.headers.get(name), name);
		assert.deepEqual(new Uint8Array(await forwarded.arrayBuffer()), bytes);
	});

	test("does not buffer a large streamed upload: APP reads it as it arrives", async () => {
		let produced = 0;
		const upload = new ReadableStream({
			pull(controller) {
				if (produced === 3) return controller.close();
				produced++;
				controller.enqueue(new Uint8Array(1024 * 1024));
			},
		});
		let producedBeforeApp = null;
		const { env } = stack(US, {
			app: async (request) => {
				producedBeforeApp = produced;
				const reader = request.body.getReader();
				let total = 0;
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					total += value.length;
				}
				return new Response(String(total));
			},
		});
		const request = new Request("https://flockstack.io/api/uploads/files", { method: "POST", body: upload, duplex: "half", headers: { "content-type": "application/octet-stream" } });
		const response = await router.fetch(request, env);
		assert.equal(await response.text(), String(3 * 1024 * 1024));
		assert.ok(producedBeforeApp <= 1, `the router pulled ${producedBeforeApp} chunks before APP started`);
	});

	test("a redirect is passed on as it is, never followed", async () => {
		const website = stack(US, { website: () => new Response(null, { status: 308, headers: { location: "/blog" } }) });
		const fromWebsite = await router.fetch(get("https://flockstack.io/blog"), website.env);
		assert.equal(fromWebsite.status, 308);
		assert.equal(fromWebsite.headers.get("location"), "/blog");
		assert.equal(website.WEBSITE.calls[0].request.redirect, "manual");
		const app = stack(US, { app: () => new Response(null, { status: 307, headers: { location: "/signin" } }) });
		const fromApp = await router.fetch(get("https://flockstack.io/campaigns"), app.env);
		assert.equal(fromApp.status, 307);
		assert.equal(fromApp.headers.get("location"), "/signin");
		assert.equal(fromApp.headers.get("x-served-by"), "app");
	});

	test("sends PUBLIC the visit as it came, without a header of its own", async () => {
		const { env, PUBLIC } = stack(US);
		await router.fetch(get("https://flockstack.io/docs", { "x-fs-region": "eu", "cf-ipcountry": "DE", cookie: "fs_consent=accepted" }), env);
		const [{ request }] = PUBLIC.calls;
		assert.equal(request.headers.get("cf-ipcountry"), "DE");
		assert.equal(request.headers.get("cookie"), "fs_consent=accepted");
		assert.equal(request.redirect, "manual");
		assert.equal(request.url, "https://flockstack.io/docs");
	});

	test("answers its own health check and nothing else on the hostname's behalf", async () => {
		const { env, APP } = stack();
		const response = await router.fetch(get(`https://flockstack.io${HEALTH_PATH}`), env);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("x-served-by"), "router");
		assert.equal(await response.text(), "ok\n");
		assert.equal(APP.calls.length, 0);
		const head = await router.fetch(new Request(`https://flockstack.io${HEALTH_PATH}`, { method: "HEAD" }), env);
		assert.equal(head.status, 200);
	});

	test("answers 502 itself only when APP, the last resort, throws", async () => {
		const { env } = stack(US, {
			app: () => {
				throw new Error("no such Worker");
			},
		});
		const response = await router.fetch(get("https://flockstack.io/signin"), env);
		assert.equal(response.status, 502);
		assert.equal(response.headers.get("x-served-by"), "router");
	});
});

describe("failing open", () => {
	const failures = {
		"throws": () => {
			throw new Error("the Worker is missing");
		},
		"rejects": () => Promise.reject(new Error("failed to start")),
		"answers 502": () => new Response("bad gateway", { status: 502 }),
		"answers 503": () => new Response("unavailable", { status: 503 }),
		"answers 504": () => new Response("timeout", { status: 504 }),
	};

	for (const [worker, path] of [["website", "/pricing"], ["website", "/"], ["public", "/docs/api"], ["public", "/terms"], ["public", "/api/v1/openapi.json"]]) {
		for (const [what, failure] of Object.entries(failures)) {
			test(`${path}: when ${worker} ${what}, the app answers`, async () => {
				const { env, APP, ...rest } = stack(US, { [worker]: failure });
				const response = await router.fetch(get(`https://flockstack.io${path}`), env);
				assert.equal(response.status, 200);
				assert.equal(await response.text(), "from app");
				assert.equal(response.headers.get("x-served-by"), "app");
				assert.equal(rest[worker.toUpperCase()].calls.length, 1);
				assert.equal(APP.calls.length, 1);
				assert.equal(APP.calls[0].request.url, `https://flockstack.io${path}`);
			});
		}
	}

	test("a Worker that does not start answering within the timeout is given up on", async () => {
		const never = () => new Promise(() => {});
		const { env, APP } = stack(US, { website: never, env: { ROUTER_TIMEOUT_MS: "40" } });
		const started = Date.now();
		const response = await router.fetch(get("https://flockstack.io/pricing"), env);
		assert.equal(await response.text(), "from app");
		assert.ok(Date.now() - started < 1000);
		assert.equal(APP.calls.length, 1);
		assert.equal(DEFAULT_TIMEOUT_MS, 3000);
	});

	test("a page that has started arriving is not cut off by the timeout", async () => {
		let release;
		const body = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("first "));
				release = () => {
					controller.enqueue(new TextEncoder().encode("second"));
					controller.close();
				};
			},
		});
		const { env, APP } = stack(US, { website: () => new Response(body), env: { ROUTER_TIMEOUT_MS: "30" } });
		const response = await router.fetch(get("https://flockstack.io/pricing"), env);
		await new Promise((resolve) => setTimeout(resolve, 80));
		release();
		assert.equal(await response.text(), "first second");
		assert.equal(APP.calls.length, 0);
	});

	test("PUBLIC saying it has no copy of a page sends the visit to the app", async () => {
		const { env, APP } = stack(US, { public: () => new Response("not here", { status: 404, headers: { "x-fs-public-miss": "1" } }) });
		const response = await router.fetch(get("https://flockstack.io/docs/api"), env);
		assert.equal(await response.text(), "from app");
		assert.equal(APP.calls.length, 1);
	});

	test("a 404 that PUBLIC gives on purpose (a legal page that is not published yet) is the answer", async () => {
		const { env, APP } = stack(US, { public: () => new Response("Not found", { status: 404 }) });
		const response = await router.fetch(get("https://flockstack.io/terms"), env);
		assert.equal(response.status, 404);
		assert.equal(response.headers.get("x-served-by"), "public");
		assert.equal(APP.calls.length, 0);
	});

	test("other error statuses from the website are its answer, not a reason to ask the app", async () => {
		for (const status of [404, 410, 500, 429]) {
			const { env, APP } = stack(US, { website: () => new Response("x", { status }) });
			const response = await router.fetch(get("https://flockstack.io/blog/x"), env);
			assert.equal(response.status, status);
			assert.equal(APP.calls.length, 0);
		}
	});
});
