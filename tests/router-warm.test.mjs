import assert from "node:assert/strict";
import { describe, test } from "node:test";
import router from "../workers/router/index.js";
import { WARM_HEADER, WARM_PATHS } from "../workers/router/routing.js";

// The router starts the app's isolate behind a visit to a page the app does not serve (docs, the website): by the time the visitor
// opens sign-in and the dashboard, the app has loaded and rendered once, which is most of a cold start (docs/PERFORMANCE.md).
const US = { FLOCKSTACK_REGION: "us", APP_URL: "https://flockstack.io" };

function binding(name, respond) {
	const calls = [];
	return { name, calls, async fetch(request) { calls.push(request); return respond ? respond(request) : new Response(`from ${name}`); } };
}

function stack(extra = {}, apps = {}) {
	const bindings = { WEBSITE: binding("website"), PUBLIC: binding("public"), APP: binding("app", apps.app), API: binding("api"), READERS: binding("readers") };
	return { ...bindings, env: { ...US, ...bindings, API_ENABLED: "all", READERS_ENABLED: "all", ...extra } };
}

function context() {
	const tasks = [];
	return { tasks, waitUntil: (promise) => tasks.push(promise) };
}

const visit = async (env, path, ctx = context(), init = {}) => {
	const response = await router.fetch(new Request(`https://flockstack.io${path}`, { redirect: "manual", ...init }), env, ctx);
	await Promise.all(ctx.tasks);
	return { response, ctx };
};

describe("warming the app", () => {
	test("a visit to a docs page or the website, with WARM_APP on, asks the app for /api/health and /signin after answering", async () => {
		for (const path of ["/docs", "/pricing", "/docs/api"]) {
			const { env, APP } = stack({ WARM_APP: "true" });
			let answeredBeforeWarm = false;
			const ctx = context();
			const response = await router.fetch(new Request(`https://flockstack.io${path}`, { redirect: "manual" }), env, ctx);
			answeredBeforeWarm = APP.calls.length === 0 || ctx.tasks.length > 0;
			assert.equal(response.status, 200);
			assert.ok(answeredBeforeWarm, "the visitor's answer does not wait for the warm-up");
			await Promise.all(ctx.tasks);
			assert.deepEqual(APP.calls.map((request) => new URL(request.url).pathname), WARM_PATHS, path);
			for (const request of APP.calls) {
				assert.equal(request.method, "GET");
				assert.equal(request.headers.get(WARM_HEADER), "1");
				assert.equal(new URL(request.url).origin, "https://flockstack.io");
				assert.equal(request.headers.get("cookie"), null, "a visitor's cookies are never forwarded");
			}
		}
	});

	test("nothing is warmed unless WARM_APP is true", async () => {
		for (const warm of [undefined, "", "false", "off", "1", "yes"]) {
			const { env, APP } = stack(warm === undefined ? {} : { WARM_APP: warm });
			await visit(env, "/docs");
			assert.equal(APP.calls.length, 0, String(warm));
		}
	});

	test("once per interval per router instance, and again after it", async () => {
		const { env, APP } = stack({ WARM_APP: "true", WARM_INTERVAL_MS: "60" });
		await visit(env, "/docs");
		await visit(env, "/docs/api");
		await visit(env, "/pricing");
		assert.equal(APP.calls.length, 2, "one warm-up for three visits");
		await new Promise((resolve) => setTimeout(resolve, 80));
		await visit(env, "/docs");
		assert.equal(APP.calls.length, 4);
		const other = stack({ WARM_APP: "true" });
		await visit(other.env, "/docs");
		assert.equal(other.APP.calls.length, 2, "another instance has its own clock");
	});

	test("only visits to pages the app does not serve warm it: the app's own, the API's and the readers' traffic never do", async () => {
		const { env, APP } = stack({ WARM_APP: "true" });
		const requests = [["/signin", "GET"], ["/campaigns", "GET"], ["/api/v1/contacts", "GET"], ["/mcp", "POST"], ["/o/abc.def", "GET"], ["/api/unsubscribe", "POST"], ["/api/health", "GET"]];
		for (const [path, method] of requests) {
			const { response } = await visit(env, path, context(), { method, body: method === "POST" ? "{}" : undefined });
			assert.notEqual(response.status, 0);
		}
		const warmCalls = APP.calls.filter((request) => request.headers.get(WARM_HEADER));
		assert.equal(warmCalls.length, 0);
	});

	test("a warm-up that fails, or is slow, changes nothing for the visitor", async () => {
		const failing = stack({ WARM_APP: "true" }, { app: () => { throw new Error("the app is missing"); } });
		const { response } = await visit(failing.env, "/docs");
		assert.equal(response.status, 200);
		const slow = stack({ WARM_APP: "true" }, { app: () => new Promise(() => {}) });
		const ctx = context();
		const answered = await router.fetch(new Request("https://flockstack.io/docs"), slow.env, ctx);
		assert.equal(answered.status, 200, "the response does not wait for the app");
	});

	test("without an execution context or the APP binding there is nothing to do", async () => {
		const { env } = stack({ WARM_APP: "true" });
		const response = await router.fetch(new Request("https://flockstack.io/docs"), env);
		assert.equal(response.status, 200);
		const noApp = stack({ WARM_APP: "true" });
		delete noApp.env.APP;
		const { response: other } = await visit(noApp.env, "/docs");
		assert.equal(other.status, 200);
	});
});
