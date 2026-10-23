import assert from "node:assert/strict";
import { describe, test } from "node:test";
import router from "../workers/router/index.js";
import { MAX_REPLAY_BYTES, READERS_UNPROCESSED_HEADER, chooseRoute } from "../workers/router/routing.js";
import { READER_GROUPS, parseReaderGroups } from "../lib/reader-routing.js";

// The router's READERS binding: which requests go to the lean readers Worker, on which hosts, when it is switched on, and the rule
// for what is asked of the app when it fails (a request that only reads is asked again; one that may have changed something never is).
const US = { FLOCKSTACK_REGION: "us", APP_URL: "https://flockstack.io" };
const APP = "https://flockstack.io";
const NEWSLETTER = "https://weekly.flockstackmail.com";
const OWN_DOMAIN = "https://news.example.com";
const TOKEN = "6650f1c2e9b1d4a012345678.AbCdEfGhIjKlMnOpQrStUv";
const FORM = "6650f1c2e9b1d4a012345678";

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

function stack({ readers, app, enabled = "all" } = {}) {
	const bindings = { WEBSITE: binding("website"), PUBLIC: binding("public"), APP: binding("app", app), API: binding("api"), READERS: binding("readers", readers) };
	return { ...bindings, env: { ...US, ...bindings, ...(enabled !== null && { READERS_ENABLED: enabled }) } };
}

const route = (env, url, { method = "GET", headers = {} } = {}) => chooseRoute({ method, url: new URL(url), headers: new Headers(headers), env });
const send = (env, url, init = {}) => router.fetch(new Request(url, { redirect: "manual", ...init }), env);
const SAMPLES = {
	tracking: [`/o/${TOKEN}`, `/c/${TOKEN}.aHR0cHM6Ly9leGFtcGxlLmNvbQ`],
	unsubscribe: ["/api/unsubscribe?token=abc"],
	beacons: ["/api/views", "/api/visit", "/api/recommendations/impression"],
	forms: [`/f/${FORM}`, "/embed.js"],
};

describe("which requests go to the readers Worker", () => {
	test("every reader path goes to READERS, with any method, on the app's host and on every newsletter's, when it is switched on", () => {
		const { env } = stack();
		for (const host of [APP, NEWSLETTER, OWN_DOMAIN]) {
			for (const path of Object.values(SAMPLES).flat()) {
				for (const method of ["GET", "HEAD", "POST", "OPTIONS"]) assert.equal(route(env, `${host}${path}`, { method }), "readers", `${method} ${host}${path}`);
			}
		}
	});

	test("the app keeps the pages and everything else, on every host", () => {
		const { env } = stack();
		const stay = ["/unsubscribe", "/confirm", "/keep", "/preferences", "/poll", "/survey", "/pledge", "/gift", `/embed/${FORM}`, "/f/not-hex", "/o", "/c/a/b", "/p/an-issue", "/reader/in", "/archive/weekly/feed", "/feed.xml", "/signin", "/", "/api/webhooks/ses", "/api/jobs/send-batch", "/api/cron/hourly", "/api/internal/revalidate", "/api/shop/download"];
		for (const host of [APP, NEWSLETTER, OWN_DOMAIN]) {
			for (const path of stay) for (const method of ["GET", "POST"]) assert.notEqual(route(env, `${host}${path}`, { method }), "readers", `${method} ${host}${path}`);
		}
		assert.equal(route(env, `${NEWSLETTER}/preferences`), "app");
		assert.equal(route(env, `${OWN_DOMAIN}/anything`), "app");
	});

	test("nothing goes to the readers Worker until READERS_ENABLED switches it on", () => {
		for (const enabled of [null, "", "false", "off", "0", "nonsense"]) {
			const { env } = stack({ enabled });
			assert.equal(route(env, `${NEWSLETTER}/o/${TOKEN}`), "app", String(enabled));
			assert.equal(route(env, `${APP}/api/unsubscribe`, { method: "POST" }), "app", String(enabled));
		}
		const noBinding = { ...US, READERS_ENABLED: "all" };
		assert.equal(route(noBinding, `${NEWSLETTER}/o/${TOKEN}`), "app", "no binding, no readers");
	});

	test("groups switch on one at a time", () => {
		for (const group of READER_GROUPS) {
			const { env } = stack({ enabled: group });
			for (const [other, paths] of Object.entries(SAMPLES)) {
				for (const path of paths) assert.equal(route(env, `${NEWSLETTER}${path}`, { method: "POST" }), other === group ? "readers" : "app", `${group} on: ${path}`);
			}
		}
		const { env } = stack({ enabled: " Tracking , beacons,bogus" });
		assert.equal(route(env, `${NEWSLETTER}/o/${TOKEN}`), "readers");
		assert.equal(route(env, `${NEWSLETTER}/api/views`, { method: "POST" }), "readers");
		assert.equal(route(env, `${NEWSLETTER}/api/unsubscribe`, { method: "POST" }), "app");
		assert.deepEqual([...parseReaderGroups("typo")], [], "a typo switches less on, never more");
	});

	test("a workers.dev address has a switch of its own, so the readers Worker can be tried there while the domains go to the app", () => {
		const trial = `https://flockstack-router.me.workers.dev/o/${TOKEN}`;
		const { env } = stack({ enabled: "all" });
		assert.equal(route(env, trial), "app", "READERS_ENABLED is the domains'");
		env.READERS_ENABLED_WORKERS_DEV = "tracking";
		assert.equal(route(env, trial), "readers");
		assert.equal(route(env, "https://flockstack-router.me.workers.dev/api/views", { method: "POST" }), "app", "only the groups it names");
		assert.equal(route(env, `${NEWSLETTER}/o/${TOKEN}`), "readers", "and the domains keep their own");
		const off = stack({ enabled: null });
		off.env.READERS_ENABLED_WORKERS_DEV = "all";
		assert.equal(route(off.env, trial), "readers", "the domains can be off while the trial is on");
		assert.equal(route(off.env, `${NEWSLETTER}/o/${TOKEN}`), "app");
	});

	test("the API's and the website's routing is untouched", () => {
		const { env } = stack();
		env.API_ENABLED = "all";
		assert.equal(route(env, `${APP}/api/v1/contacts`), "api");
		assert.equal(route(env, `${APP}/pricing`), "website");
		assert.equal(route(env, `${APP}/docs`), "public");
		assert.equal(route(env, `${APP}/campaigns`), "app");
	});
});

describe("passing requests through", () => {
	test("the readers Worker gets the request itself, with its exact bytes and headers, and the app is not asked", async () => {
		const bytes = new TextEncoder().encode("token=abc&source=page");
		const { env, READERS, APP: appBinding } = stack({ readers: () => new Response(null, { status: 200, headers: { "cache-control": "no-store" } }) });
		const request = new Request(`${NEWSLETTER}/api/unsubscribe?token=abc`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "content-length": String(bytes.length), "cf-connecting-ip": "203.0.113.4", "user-agent": "Gmail" }, body: bytes, redirect: "manual" });
		const response = await router.fetch(request, env);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("x-served-by"), "readers");
		assert.match(response.headers.get("server-timing"), /readers;dur=\d+, router;dur=\d+/);
		assert.equal(READERS.calls.length, 1);
		assert.equal(appBinding.calls.length, 0);
		assert.equal(READERS.calls[0].request, request, "the same Request object");
		assert.equal(READERS.calls[0].request.headers.get("cf-connecting-ip"), "203.0.113.4");
	});

	test("a redirect and a pixel are passed on as the Worker made them", async () => {
		const { env } = stack({ readers: () => new Response(null, { status: 302, headers: { location: "https://example.com/a", "cache-control": "no-store" } }) });
		const response = await send(env, `${NEWSLETTER}/c/${TOKEN}.aHR0cHM6Ly9leGFtcGxlLmNvbQ`);
		assert.equal(response.status, 302);
		assert.equal(response.headers.get("location"), "https://example.com/a");
	});

	test("a request for a newsletter's host that is not a reader path goes to the app untouched, as before", async () => {
		const { env, READERS, APP: appBinding } = stack();
		const response = await send(env, `${NEWSLETTER}/p/an-issue`);
		assert.equal(response.headers.get("x-served-by"), "app");
		assert.equal(READERS.calls.length, 0);
		assert.equal(appBinding.calls[0].request.url, `${NEWSLETTER}/p/an-issue`);
	});

	test("http and www on the app's own host are redirected before the readers Worker is asked, and a newsletter's host is not touched", async () => {
		const { env, READERS } = stack();
		const redirected = await send(env, `http://flockstack.io/o/${TOKEN}`);
		assert.equal(redirected.status, 308);
		const plain = await send(env, `http://weekly.flockstackmail.com/o/${TOKEN}`);
		assert.equal(plain.status, 200, "a newsletter's http is the zone's to redirect, as before");
		assert.equal(READERS.calls.length, 1);
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
		"says it is not its path": () => new Response("Not found", { status: 404, headers: { "x-fs-readers-miss": "1" } }),
		"says it did nothing": () => new Response("off", { status: 503, headers: { [READERS_UNPROCESSED_HEADER]: "1" } }),
	};

	for (const path of [`/o/${TOKEN}`, `/c/${TOKEN}.aHR0cHM6Ly9leGFtcGxlLmNvbQ`, "/embed.js", "/api/unsubscribe?token=x"]) {
		for (const method of ["GET", "HEAD"]) {
			for (const [what, failure] of Object.entries(failures)) {
				test(`${method} ${path.slice(0, 12)}: when the readers Worker ${what}, the app answers`, async () => {
					const { env, READERS, APP: appBinding } = stack({ readers: failure });
					const response = await send(env, `${NEWSLETTER}${path}`, { method, headers: { "user-agent": "Gmail" } });
					assert.equal(response.headers.get("x-served-by"), "app");
					if (method === "GET") assert.equal(await response.text(), "from app");
					assert.equal(READERS.calls.length, 1);
					assert.equal(appBinding.calls.length, 1);
					assert.equal(appBinding.calls[0].request.url, `${NEWSLETTER}${path}`);
					assert.equal(appBinding.calls[0].request.headers.get("user-agent"), "Gmail");
				});
			}
		}
	}

	test("a GET the readers Worker does not start answering in time is asked of the app too", async () => {
		const { env, APP: appBinding } = stack({ readers: () => new Promise(() => {}) });
		env.ROUTER_READERS_TIMEOUT_MS = "40";
		const response = await send(env, `${NEWSLETTER}/o/${TOKEN}`);
		assert.equal(await response.text(), "from app");
		assert.equal(appBinding.calls.length, 1);
	});

	for (const path of ["/api/unsubscribe?token=x", "/api/views", `/f/${FORM}`]) {
		test(`POST ${path.slice(0, 14)}: a failure of the readers Worker is never replayed to the app`, async () => {
			for (const failure of [failures.throws, failures.rejects]) {
				const { env, APP: appBinding } = stack({ readers: failure });
				const response = await send(env, `${NEWSLETTER}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"a":1}' });
				assert.equal(response.status, 502);
				assert.equal(response.headers.get("x-served-by"), "readers");
				assert.equal(appBinding.calls.length, 0, "the app was not asked");
			}
		});
	}

	test("a POST answered 502, 503 or 504 by the readers Worker is that answer: the app is not asked", async () => {
		for (const status of [502, 503, 504]) {
			const { env, APP: appBinding } = stack({ readers: () => new Response("busy", { status }) });
			const response = await send(env, `${NEWSLETTER}/api/unsubscribe?token=x`, { method: "POST", body: "source=page" });
			assert.equal(response.status, status);
			assert.equal(appBinding.calls.length, 0);
		}
	});

	test("a POST the readers Worker says it did nothing for goes to the app with the exact bytes of its body", async () => {
		const bytes = new Uint8Array(Array.from({ length: 512 }, (_, index) => (index * 13 + 1) % 256));
		const { env, READERS, APP: appBinding } = stack({ readers: async (request) => { await request.arrayBuffer(); return new Response("off", { status: 503, headers: { [READERS_UNPROCESSED_HEADER]: "1" } }); } });
		const request = new Request(`${NEWSLETTER}/f/${FORM}`, { method: "POST", headers: { "content-length": String(bytes.length), "content-type": "application/octet-stream", "x-test": "1" }, body: bytes, redirect: "manual" });
		const response = await router.fetch(request, env);
		assert.equal(await response.text(), "from app");
		assert.equal(READERS.calls.length, 1);
		assert.equal(appBinding.calls.length, 1);
		assert.deepEqual(new Uint8Array(await appBinding.calls[0].request.arrayBuffer()), bytes);
		assert.equal(appBinding.calls[0].request.headers.get("x-test"), "1");
	});

	test("a POST body over the copy limit is not copied: the readers Worker's 'did nothing' is returned as it is", async () => {
		const { env, APP: appBinding } = stack({ readers: () => new Response("off", { status: 503, headers: { [READERS_UNPROCESSED_HEADER]: "1" } }) });
		const request = new Request(`${NEWSLETTER}/f/${FORM}`, { method: "POST", headers: { "content-length": String(MAX_REPLAY_BYTES + 1) }, body: "x", redirect: "manual", duplex: "half" });
		const response = await router.fetch(request, env);
		assert.equal(response.status, 503);
		assert.equal(appBinding.calls.length, 0);
	});

	test("with the readers Worker off in the router, everything is the app's as before", async () => {
		const { env, READERS, APP: appBinding } = stack({ enabled: null });
		for (const [method, path] of [["GET", `/o/${TOKEN}`], ["POST", "/api/unsubscribe?token=x"], ["POST", "/api/views"], ["GET", "/embed.js"]]) {
			const response = await send(env, `${NEWSLETTER}${path}`, { method, body: method === "POST" ? "{}" : undefined });
			assert.equal(response.headers.get("x-served-by"), "app", path);
		}
		assert.equal(READERS.calls.length, 0);
		assert.equal(appBinding.calls.length, 4);
	});
});
