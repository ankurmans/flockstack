import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, describe, test } from "node:test";
import worker from "../workers/readers/index.js";
import { handleReaderRequest } from "../workers/readers/handler.js";
import { anonymous, startTestApp } from "./helpers/app.mjs";
import { flushAfter } from "./stubs/next-server.mjs";

// The readers Worker's entry and route table (workers/readers), run in the test process on the same modules the app's routes use:
// what it answers for each endpoint is what the Next.js route answers, plus the headers Next.js adds, and the router can tell it
// apart from the app (x-fs-readers-* headers). The suites of each endpoint (tracking, unsubscribe, forms, visits, recommendations)
// also run against this handler with FLOCKSTACK_READERS_TARGET=worker (tests/readers-worker-parity.test.mjs).
const SECRET = "test-secret-for-integration-tests-0123456789";
const MESSAGE_ID = "66f1a2b3c4d5e6f7a8b9c0d1";
const CONTACT_ID = "64f1a2b3c4d5e6f7a8b9c0d1";
const NEWSLETTER_ID = "74f1a2b3c4d5e6f7a8b9c0d2";
const BASE = "https://weekly.flockstackmail.com";
const ctx = { waitUntil: (promise) => pending.push(promise) };
const pending = [];
let app;

before(async () => {
	app = await startTestApp();
});
after(() => app?.stop());

const env = { DB: {} };
const ask = (url, init) => worker.fetch(new Request(url, init), env, ctx);
async function settle() {
	await Promise.allSettled(pending.splice(0));
	await flushAfter();
}

// The signature of a link the way an email already sent carries it, computed here and not by the app's functions: a link in an inbox
// has to keep working, whatever the code looks like later (lib/tracking.js, lib/unsubscribe.js).
function hkdf(label) {
	return Buffer.from(crypto.hkdfSync("sha256", SECRET, "", label, 32));
}
const signTracking = (value) => crypto.createHmac("sha256", hkdf("flockstack-tracking-v1")).update(value).digest("base64url").slice(0, 22);

describe("what the Worker answers", () => {
	test("an open pixel from an email already sent: the GIF, never cached, and the open is recorded after the answer", async () => {
		const response = await ask(`${BASE}/o/${MESSAGE_ID}.${signTracking(`open:${MESSAGE_ID}`)}`);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("content-type"), "image/gif");
		assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
		assert.equal(response.headers.get("x-served-by"), "readers");
		assert.match(response.headers.get("server-timing"), /^readers;dur=\d+$/);
		assert.equal(new Uint8Array(await response.arrayBuffer()).length, 42);
		await settle();
	});

	test("a pixel with a bad signature is the same GIF, nothing recorded, as it is for the app", async () => {
		const response = await ask(`${BASE}/o/${MESSAGE_ID}.${"A".repeat(22)}`);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("content-type"), "image/gif");
	});

	test("a click link from an email already sent redirects to its address, a link with no valid signature offers a page, and a malformed one is a 404", async () => {
		const url = "https://example.org/read?a=1&b=2";
		const encoded = Buffer.from(url).toString("base64url");
		const token = `${MESSAGE_ID}.${signTracking(`click:${MESSAGE_ID}:3:${url}`)}.3.${encoded}`;
		const redirect = await ask(`${BASE}/c/${token}`, { headers: { "user-agent": "Mozilla/5.0 Chrome/141" } });
		assert.equal(redirect.status, 302);
		assert.equal(redirect.headers.get("location"), url);
		assert.equal(redirect.headers.get("cache-control"), "no-store");
		const head = await ask(`${BASE}/c/${token}`, { method: "HEAD" });
		assert.equal(head.status, 302);
		assert.equal(head.headers.get("location"), url);
		const unsigned = await ask(`${BASE}/c/${MESSAGE_ID}.${"B".repeat(22)}.3.${encoded}`);
		assert.equal(unsigned.status, 200);
		assert.match(await unsigned.text(), /This link goes to:/);
		assert.equal((await ask(`${BASE}/c/not-a-link`)).status, 404);
		// Older links, from before a link carried its place.
		const old = `${MESSAGE_ID}.${signTracking(`click:${MESSAGE_ID}:${url}`)}.${encoded}`;
		assert.equal((await ask(`${BASE}/c/${old}`)).headers.get("location"), url);
		await settle();
	});

	test("unsubscribe: a GET only sends the browser to the page, a POST of nothing valid is refused, and the list-unsubscribe one-click needs no body", async () => {
		const get = await ask(`${BASE}/api/unsubscribe?token=abc`);
		assert.equal(get.status, 303);
		assert.equal(get.headers.get("location"), `${BASE}/unsubscribe?token=abc`);
		assert.equal(get.headers.get("cache-control"), "no-store");
		const invalid = await ask(`${BASE}/api/unsubscribe?token=abc`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
		assert.equal(invalid.status, 400);
		assert.equal(invalid.headers.get("cache-control"), "no-store");
		const page = await ask(`${BASE}/api/unsubscribe?token=abc`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "source=page" });
		assert.equal(page.status, 303);
		assert.equal(page.headers.get("location"), `${BASE}/unsubscribe?status=invalid`);
	});

	test("the beacons answer 204 whatever they are sent, and a form's address answers its preflight", async () => {
		for (const path of ["/api/views", "/api/visit", "/api/recommendations/impression"]) {
			const response = await ask(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0 Chrome/141" }, body: "{}" });
			assert.equal(response.status, 204, path);
			assert.equal(response.headers.get("cache-control"), "no-store");
		}
		const preflight = await ask(`${BASE}/f/6650f1c2e9b1d4a012345678`, { method: "OPTIONS", headers: { origin: "https://site.example" } });
		assert.equal(preflight.status, 204);
		assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
		const missing = await ask(`${BASE}/f/6650f1c2e9b1d4a012345678`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: '{"email":"a@example.com"}' });
		assert.equal(missing.status, 404);
		assert.equal((await missing.json()).error, "This form is gone.");
	});

	test("the embed script is the same file on every host, with the headers other sites need", async () => {
		const response = await ask(`${BASE}/embed.js`);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("content-type"), "text/javascript; charset=utf-8");
		assert.equal(response.headers.get("access-control-allow-origin"), "*");
		assert.equal(response.headers.get("cross-origin-resource-policy"), "cross-origin");
		const { EMBED_SCRIPT } = await import("../lib/embed-script.js");
		assert.equal(await response.text(), EMBED_SCRIPT);
	});
});

describe("how the Worker behaves like Next.js", () => {
	test("every response carries the security headers Next.js adds to every route, unless the route set its own", async () => {
		const { SECURITY_HEADERS } = await import("../lib/security-headers.js");
		for (const path of ["/embed.js", `/o/${MESSAGE_ID}.${"A".repeat(22)}`, "/api/views"]) {
			const response = await ask(`${BASE}${path}`, { method: path === "/api/views" ? "POST" : "GET", body: path === "/api/views" ? "{}" : undefined });
			for (const { key, value } of SECURITY_HEADERS) assert.equal(response.headers.get(key), value, `${path} ${key}`);
		}
	});

	test("HEAD is the GET without a body, OPTIONS lists the methods, another method is a 405 with Allow, and a trailing slash is a 308", async () => {
		const head = await ask(`${BASE}/embed.js`, { method: "HEAD" });
		assert.equal(head.status, 200);
		assert.equal(await head.text(), "");
		const options = await ask(`${BASE}/api/views`, { method: "OPTIONS" });
		assert.equal(options.status, 204);
		assert.equal(options.headers.get("allow"), "POST, OPTIONS");
		const wrong = await ask(`${BASE}/api/views`);
		assert.equal(wrong.status, 405);
		assert.equal(wrong.headers.get("allow"), "POST, OPTIONS");
		const slash = await ask(`${BASE}/api/unsubscribe/?token=x`);
		assert.equal(slash.status, 308);
		assert.equal(slash.headers.get("location"), "/api/unsubscribe?token=x");
	});

	test("a path that is not the Worker's is a 404 marked for the router, and nothing is read from the body", async () => {
		for (const path of ["/", "/unsubscribe", "/p/an-issue", "/preferences", "/api/webhooks/ses", "/f/not-hex"]) {
			const response = await ask(`${BASE}${path}`, { method: "POST", body: "x" });
			assert.equal(response.status, 404, path);
			assert.equal(response.headers.get("x-fs-readers-miss"), "1", path);
		}
		assert.equal((await handleReaderRequest(new Request(`${BASE}/signin`))).headers.get("x-fs-readers-miss"), "1");
	});

	test("an undecodable token is a 400, as it is in Next.js", async () => {
		const response = await ask(`${BASE}/o/%E0%A4%A`);
		assert.equal(response.status, 400);
	});
});

describe("switched off, or with no database, it does nothing and says so", () => {
	test("READERS_DISABLED answers 503 before reading anything, marked unprocessed, for the router to hand the request to the app", async () => {
		let read = false;
		const request = new Request(`${BASE}/api/unsubscribe?token=x`, { method: "POST", body: "source=page" });
		request.formData = async () => {
			read = true;
			return new FormData();
		};
		const response = await worker.fetch(request, { DB: {}, READERS_DISABLED: "true" }, ctx);
		assert.equal(response.status, 503);
		assert.equal(response.headers.get("x-fs-readers-unprocessed"), "1");
		assert.equal(read, false);
		assert.equal(response.headers.get("x-served-by"), "readers");
	});

	test("no DB binding is the same", async () => {
		const response = await worker.fetch(new Request(`${BASE}/o/x`), {}, ctx);
		assert.equal(response.status, 503);
		assert.equal(response.headers.get("x-fs-readers-unprocessed"), "1");
	});
});

describe("anonymous visits through the app's own routes match", () => {
	test("the pixel route and the Worker give the same bytes and headers", async () => {
		const route = await import("../app/o/[token]/route.js");
		const token = `${MESSAGE_ID}.${signTracking(`open:${MESSAGE_ID}`)}`;
		const expected = await anonymous(() => route.GET(new Request(`${BASE}/o/${token}`), { params: Promise.resolve({ token }) }));
		const actual = await ask(`${BASE}/o/${token}`);
		assert.equal(actual.status, expected.status);
		for (const name of ["content-type", "cache-control"]) assert.equal(actual.headers.get(name), expected.headers.get(name), name);
		assert.deepEqual(new Uint8Array(await actual.arrayBuffer()), new Uint8Array(await expected.arrayBuffer()));
		await settle();
	});
});
