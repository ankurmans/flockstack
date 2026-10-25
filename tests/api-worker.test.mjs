import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { activate, as, catchRedirect, form, jsonRequest, signIn, startTestApp } from "./helpers/app.mjs";
import { flushAfter } from "./stubs/next-server.mjs";
import { revalidatedPaths } from "./stubs/next-cache.mjs";

// The lean API Worker (workers/api) next to the Next.js routes: the same requests through both give the same answers, every REST action
// has a route in both, and the Worker's own parts (route table, switches, headers, revalidation) do what workers/api/index.js says.
// FLOCKSTACK_API_TARGET=worker runs the rest of the suite against the Worker instead (tests/api-worker-parity.test.mjs).
let app;
let m;
let owner;
let worker;

async function customer(email, slug) {
	const user = await signIn(email);
	await activate(user);
	const url = await as(user, () => catchRedirect(m.newsletters.saveNewsletter(null, form({ name: `${slug} news`, slug, postalAddress: "1 Main St, Paris" }))));
	user.newsletterId = url.split("/").at(-1);
	user.slug = slug;
	user.fullKey = (await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Agent", level: "full" })))).key;
	user.signupKey = (await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Site", level: "signups" })))).key;
	return user;
}

before(async () => {
	app = await startTestApp();
	m = {
		newsletters: await import("../app/(app)/newsletters/actions.js"),
		contacts: await import("../app/(app)/contacts/actions.js"),
		apiKeys: await import("../app/(app)/api-keys/actions.js"),
		registry: await import("../lib/actions/registry.js"),
		rest: await import("../app/api/v1/[...path]/route.js"),
		mcpRoute: await import("../app/mcp/route.js"),
		handler: await import("../workers/api/handler.js"),
		index: (await import("../workers/api/index.js")).default,
		hooks: await import("../workers/api/runtime-hooks.js"),
		runtime: await import("../workers/api/shims/runtime.js"),
		revalidate: await import("../app/api/internal/revalidate/route.js"),
		internal: await import("../lib/internal-revalidate.js"),
	};
	owner = await customer("worker-owner@example.com", "worker-owner");
	await as(owner, () => m.contacts.importContacts({ newsletterId: owner.newsletterId, consent: true, rows: [{ email: "reader@example.org", status: "active" }] }));
	worker = (request) => m.handler.handleApiRequest(request);
});

after(() => app?.stop());

// Through the Next.js route, as Next.js calls it.
async function throughNext(request, segments) {
	return m.rest[request.method](request, { params: Promise.resolve({ path: segments }) });
}

// A call counts against its key (callsToday, lastUsedAt), so the second of two identical calls sees the first.
const read = async (response) => ({ status: response.status, body: (await response.clone().text()).replace(/"callsToday":\d+/g, '"callsToday":0').replace(/"lastUsedAt":("[^"]*"|null)/g, '"lastUsedAt":null'), type: response.headers.get("content-type"), challenge: response.headers.get("www-authenticate"), allow: response.headers.get("allow"), cors: response.headers.get("access-control-allow-origin") });

function fill(path) {
	return path.replace(/\{[^}]+\}/g, "abc");
}

describe("the same routes in both", () => {
	test("every REST action answers the same through Next.js and the Worker, and no action is missing from either", async () => {
		assert.ok(m.registry.ACTIONS.length > 100);
		for (const action of m.registry.ACTIONS) {
			const path = `/api/v1${fill(action.http.path)}`;
			const request = () => jsonRequest(path, { method: action.http.method, ...(["POST", "PATCH"].includes(action.http.method) && { body: {} }) });
			const segments = path.replace(/^\/api\/v1\//, "").split("/");
			const next = await read(await throughNext(request(), segments));
			const lean = await read(await worker(request()));
			assert.deepEqual(lean, next, `${action.http.method} ${path}`);
			assert.equal(next.status, 401, `${action.name} answers 401 without a key (it exists), not 404`);
		}
	});

	test("a path that is no action answers the same 404 in both", async () => {
		for (const [method, path] of [["GET", "/api/v1/nothing/here"], ["DELETE", "/api/v1/contacts"], ["GET", "/api/v1"]]) {
			const segments = path.replace(/^\/api\/v1\/?/, "").split("/").filter(Boolean);
			const next = await read(await throughNext(jsonRequest(path, { method }), segments));
			const lean = await read(await worker(jsonRequest(path, { method })));
			assert.deepEqual(lean, next, `${method} ${path}`);
		}
	});

	test("the read-only actions answer the same with a key", async () => {
		const headers = { authorization: `Bearer ${owner.fullKey}` };
		let compared = 0;
		for (const action of m.registry.ACTIONS.filter((candidate) => candidate.http.method === "GET" && !candidate.http.path.includes("{") && !candidate.http.path.includes("export") && !candidate.http.path.includes("activity"))) {
			const path = `/api/v1${action.http.path}`;
			const segments = path.replace(/^\/api\/v1\//, "").split("/");
			const next = await read(await throughNext(jsonRequest(path, { headers }), segments));
			const lean = await read(await worker(jsonRequest(path, { headers })));
			assert.deepEqual(lean, next, `GET ${path}`);
			compared++;
		}
		assert.ok(compared >= 15, `${compared} read-only actions compared`);
	});

	test("the guard runs in the Worker: a call is logged under its request id, and an approval waits as a 202", async () => {
		const headers = { authorization: `Bearer ${owner.fullKey}` };
		const call = await worker(jsonRequest("/api/v1/connected-apps", { headers }));
		assert.equal(call.status, 200);
		const requestId = call.headers.get("x-request-id");
		assert.match(requestId, /^req_/);
		const log = await (await worker(jsonRequest("/api/v1/agent-activity", { headers }))).json();
		assert.ok(log.activity.some((entry) => entry.requestId === requestId && entry.action === "list_connected_apps"), `the call is in the activity log: ${requestId} ${JSON.stringify(log.activity.slice(0, 3))}`);
	});

	test("the preflight, the signups key's CORS answer and a rate limit are the same", async () => {
		const preflight = (path) => jsonRequest(path, { method: "OPTIONS", headers: { "access-control-request-method": "POST", origin: "https://site.example" } });
		const next = await read(await m.rest.OPTIONS(preflight("/api/v1/contacts"), { params: Promise.resolve({ path: ["contacts"] }) }));
		const lean = await read(await worker(preflight("/api/v1/contacts")));
		assert.deepEqual(lean, next);
		assert.equal(lean.status, 204);
		assert.equal(lean.cors, "*");
		const signup = (call) => call(jsonRequest("/api/v1/contacts", { method: "POST", body: { newsletter: owner.slug, email: `site-${Math.random().toString(36).slice(2)}@example.org` }, headers: { authorization: `Bearer ${owner.signupKey}` } }));
		const viaWorker = await signup(worker);
		assert.equal(viaWorker.status, 201);
		assert.equal(viaWorker.headers.get("access-control-allow-origin"), "*");
	});

	test("the OpenAPI document, the discovery documents and the MCP tool list are the same", async () => {
		const openapi = await (await import("../app/api/v1/openapi.json/route.js")).GET();
		assert.equal(JSON.stringify(await (await worker(jsonRequest("/api/v1/openapi.json"))).json()), JSON.stringify(await openapi.json()));
		for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"]) {
			const route = await import(`../app${path}/route.js`);
			assert.equal(await (await worker(jsonRequest(path))).text(), await (await route.GET(jsonRequest(path))).text(), path);
		}
		const list = (route, call) => call(new Request("http://localhost:3000/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", authorization: `Bearer ${owner.fullKey}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) }));
		const viaNext = await (await list(m.mcpRoute, (request) => m.mcpRoute.POST(request))).text();
		const viaWorker = await (await list(null, worker)).text();
		assert.equal(viaWorker, viaNext);
		assert.ok(JSON.parse(viaWorker.split("\n").find((line) => line.startsWith("data: ")).slice(6)).result.tools.length > 100);
	});
});

describe("the Worker's routing", () => {
	test("a trailing slash redirects like Next.js does, with the query kept", async () => {
		const response = await worker(jsonRequest("/api/v1/contacts/?limit=2"));
		assert.equal(response.status, 308);
		assert.equal(response.headers.get("location"), "/api/v1/contacts?limit=2");
	});

	test("HEAD is the GET without a body, OPTIONS lists the methods, and a method the route lacks is a 405", async () => {
		const head = await worker(new Request("http://localhost:3000/.well-known/oauth-protected-resource", { method: "HEAD" }));
		assert.equal(head.status, 200);
		assert.equal(await head.text(), "");
		const options = await worker(new Request("http://localhost:3000/mcp", { method: "OPTIONS" }));
		assert.equal(options.status, 204);
		assert.match(options.headers.get("allow"), /GET.*POST.*OPTIONS|DELETE.*GET.*POST/);
		const refused = await worker(new Request("http://localhost:3000/mcp", { method: "PUT", body: "{}" }));
		assert.equal(refused.status, 405);
		assert.ok(refused.headers.get("allow"));
		const wellKnown = await worker(new Request("http://localhost:3000/.well-known/openid-configuration", { method: "POST", body: "{}" }));
		assert.equal(wellKnown.status, 405);
	});

	test("what is not the Worker's path is marked, so the router can hand it to the app", async () => {
		for (const path of ["/signin", "/api/auth/oauth2/authorize", "/.well-known/pki-validation/x.txt", "/mcp/extra", "/"]) {
			const response = await worker(jsonRequest(path));
			assert.equal(response.status, 404, path);
			assert.equal(response.headers.get("x-fs-api-miss"), "1", path);
		}
	});
});

describe("the Worker's entry", () => {
	const env = { DB: {}, API_DISABLED: undefined };
	const ctx = () => ({ pending: [], waitUntil(promise) { this.pending.push(promise); } });

	test("adds the headers the app's responses carry, and says how long it took", async () => {
		const response = await m.index.fetch(jsonRequest("/api/v1/contacts"), env, ctx());
		assert.equal(response.status, 401);
		assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
		assert.equal(response.headers.get("x-content-type-options"), "nosniff");
		assert.equal(response.headers.get("x-frame-options"), "DENY");
		assert.match(response.headers.get("strict-transport-security"), /max-age=63072000/);
		assert.equal(response.headers.get("referrer-policy"), "strict-origin");
		assert.match(response.headers.get("server-timing"), /^api;dur=\d+$/);
		assert.deepEqual(await response.json(), { error: { code: "unauthorized", message: "Send a valid API key: Authorization: Bearer <key>" } });
	});

	test("the same security headers as next.config.mjs sends", async () => {
		const config = (await import("../next.config.mjs")).default;
		const [{ headers }] = await config.headers();
		const response = await m.index.fetch(jsonRequest("/mcp", { method: "OPTIONS" }), env, ctx());
		for (const { key, value } of headers) assert.equal(response.headers.get(key), value, key);
	});

	test("an exception in the Worker is a 503 in the API's error shape, which the router retries on the app for a GET, not a thrown error", async () => {
		const { getDriver, setDriver } = await import("../lib/docdb/driver.js");
		const working = await getDriver();
		const broken = async () => {
			throw new Error("D1 is down");
		};
		const original = console.error;
		console.error = () => {};
		setDriver({ ...working, query: broken, batch: broken });
		try {
			const response = await m.index.fetch(jsonRequest("/api/v1/contacts", { headers: { authorization: `Bearer ${owner.fullKey}` } }), env, ctx());
			assert.equal(response.status, 503);
			assert.equal(response.headers.get("retry-after"), "5");
			assert.equal(response.headers.get("x-fs-api-unprocessed"), null, "something may have happened: the router must not run it again");
			assert.match(response.headers.get("server-timing"), /^api;dur=\d+$/);
			assert.equal((await response.json()).error.code, "unavailable");
		} finally {
			setDriver(working);
			console.error = original;
		}
	});

	test("API_DISABLED and a missing database answer 503 with the mark that tells the router nothing happened", async () => {
		for (const bad of [{ DB: {}, API_DISABLED: "true" }, { API_DISABLED: "TRUE", DB: {} }, {}]) {
			const response = await m.index.fetch(jsonRequest("/api/v1/contacts", { method: "POST", body: { a: 1 } }), bad, ctx());
			assert.equal(response.status, 503);
			assert.equal(response.headers.get("x-fs-api-unprocessed"), "1");
			assert.equal(response.headers.get("cache-control"), "no-store");
		}
	});
});

describe("revalidating pages from the Worker", () => {
	const secret = () => process.env.BETTER_AUTH_SECRET;

	test("a page dropped during a request is sent to the app once, signed, when the request is done", async () => {
		const sent = [];
		const env = { APP: { fetch: async (request) => { sent.push({ url: request.url, signature: request.headers.get(m.internal.SIGNATURE_HEADER), body: await request.text(), method: request.method }); return Response.json({ revalidated: 2 }); } } };
		const pending = [];
		let revalidations;
		await m.runtime.runInRequest({ waitUntil: (promise) => pending.push(promise) }, async (store) => {
			m.hooks.revalidatePath("/archive/[slug]", "layout");
			m.hooks.revalidatePath("/campaigns");
			m.hooks.revalidatePath("/campaigns");
			m.hooks.after(async () => { m.hooks.revalidatePath("/campaigns/0123456789abcdef01234567"); });
			revalidations = store.revalidations;
		});
		await Promise.all(pending);
		assert.equal(revalidations.size, 3);
		await m.hooks.flushRevalidations(revalidations, env);
		assert.equal(sent.length, 1);
		assert.equal(sent[0].method, "POST");
		assert.ok(sent[0].url.endsWith("/api/internal/revalidate"));
		assert.deepEqual(JSON.parse(sent[0].body).paths.map(({ path }) => path).sort(), ["/archive/[slug]", "/campaigns", "/campaigns/0123456789abcdef01234567"]);
		assert.ok(m.internal.verifySignature(sent[0].body, sent[0].signature, secret()));
		// The app takes it.
		revalidatedPaths.length = 0;
		const accepted = await m.revalidate.POST(new Request("http://localhost:3000/api/internal/revalidate", { method: "POST", body: sent[0].body, headers: { [m.internal.SIGNATURE_HEADER]: sent[0].signature } }));
		assert.equal(accepted.status, 200);
		assert.deepEqual(revalidatedPaths.map(([path]) => path).sort(), ["/archive/[slug]", "/campaigns", "/campaigns/0123456789abcdef01234567"]);
	});

	test("the app refuses what is not signed with its secret, is stale, or names a page that may not be dropped", async () => {
		const call = (body, signature) => m.revalidate.POST(new Request("http://localhost:3000/api/internal/revalidate", { method: "POST", body, headers: signature ? { [m.internal.SIGNATURE_HEADER]: signature } : {} }));
		const body = m.internal.buildRevalidateBody([["/campaigns"]]);
		revalidatedPaths.length = 0;
		assert.equal((await call(body)).status, 401, "unsigned");
		assert.equal((await call(body, m.internal.signBody(body, "another-secret-another-secret-0123456789"))).status, 401, "another secret");
		assert.equal((await call(`${body} `, m.internal.signBody(body, secret()))).status, 401, "a body that changed");
		const old = m.internal.buildRevalidateBody([["/campaigns"]], Date.now() - 10 * 60_000);
		assert.equal((await call(old, m.internal.signBody(old, secret()))).status, 400, "stale");
		for (const path of ["/admin", "/", "/api/v1/contacts", "/campaigns/../admin", "/archive/x/../../admin"]) {
			const bad = m.internal.buildRevalidateBody([[path]]);
			assert.equal((await call(bad, m.internal.signBody(bad, secret()))).status, 400, path);
		}
		assert.equal(revalidatedPaths.length, 0, "nothing was dropped");
	});

	test("without a binding or a secret the Worker only says so", async () => {
		const warn = console.warn;
		const lines = [];
		console.warn = (line) => lines.push(line);
		try {
			await m.hooks.flushRevalidations(new Map([["/campaigns", undefined]]), {});
			await m.hooks.flushRevalidations(new Map(), { APP: { fetch: () => assert.fail("nothing to send") } });
			await m.hooks.flushRevalidations(new Map([["/campaigns", undefined]]), { APP: { fetch: async () => { throw new Error("down"); } } });
		} finally {
			console.warn = warn;
		}
		assert.equal(lines.length, 2);
		await flushAfter();
	});
});
