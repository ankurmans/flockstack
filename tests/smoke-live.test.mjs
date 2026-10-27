import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { activate, as, callRoute, catchRedirect, form, signIn, startTestApp } from "./helpers/app.mjs";
import { ACTION_MANIFEST } from "../lib/actions/manifest.js";
import { CHECKS, ReadOnlyViolation, assertReadOnlyRest, assertReadOnlyTool, expectedTools, formatResults, isSmokeRead, runSmoke, shapeProblem, summarize } from "../scripts/smoke-live.mjs";

// scripts/smoke-live.mjs against the app's own REST and MCP routes, and the guard that keeps it read-only.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const APP_URL = "http://localhost:3000";
let app;
let routes;
let owner;
let empty;

async function appFetch(input, init) {
	const request = new Request(input, init);
	const url = new URL(request.url);
	if (url.origin !== APP_URL) throw new Error(`Unexpected request to ${url}`);
	if (url.pathname === "/mcp") return callRoute(routes.mcp, request.method, request);
	if (url.pathname.startsWith("/api/v1/")) {
		const segments = url.pathname.replace(/^\/api\/v1\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
		if (!routes.rest[request.method]) return new Response("Method not allowed", { status: 405 });
		return callRoute(routes.rest, request.method, request, { params: Promise.resolve({ path: segments }) });
	}
	return new Response("Not found", { status: 404 });
}

before(async () => {
	app = await startTestApp();
	routes = { mcp: await import("../app/mcp/route.js"), rest: await import("../app/api/v1/[...path]/route.js") };
	const newsletters = await import("../app/(app)/newsletters/actions.js");
	const apiKeys = await import("../app/(app)/api-keys/actions.js");
	owner = await signIn("smoke-owner@example.com");
	await activate(owner);
	const url = await as(owner, () => catchRedirect(newsletters.saveNewsletter(null, form({ name: "Smoke news", slug: "smoke-news", postalAddress: "1 Main St, Paris" }))));
	owner.newsletterId = url.split("/").at(-1);
	owner.fullKey = (await as(owner, () => apiKeys.createApiKey(null, form({ name: "Smoke full", level: "full" })))).key;
	owner.readKey = (await as(owner, () => apiKeys.createApiKey(null, form({ name: "Smoke read", level: "read_only" })))).key;
	empty = await signIn("smoke-empty@example.com");
	await activate(empty);
	empty.fullKey = (await as(empty, () => apiKeys.createApiKey(null, form({ name: "Smoke empty", level: "full" })))).key;
});

after(() => app?.stop());

const failures = (results) => results.filter(({ ok }) => ok === false);

describe("against the app", () => {
	test("a full key passes every check and sees every public tool", async () => {
		const results = await runSmoke({ baseUrl: APP_URL, apiKey: owner.fullKey, level: "full", fetchImpl: appFetch });
		assert.deepEqual(failures(results), [], formatResults(results));
		assert.equal(results.filter(({ skipped }) => skipped).length, 0);
		const tools = results.find(({ name }) => name.startsWith("MCP tools/list"));
		const publicActions = ACTION_MANIFEST.filter(([, , , , , dashboardOnly]) => !dashboardOnly).length;
		assert.match(tools.detail, new RegExp(`^${publicActions} tools, expected ${publicActions};`));
		assert.ok(results.length > CHECKS.length, "REST checks, the unauthenticated one, initialize, tools/list and the tool calls");
		assert.ok(results.every(({ ms }) => Number.isInteger(ms) && ms >= 0));
		assert.ok(!formatResults(results).includes(owner.fullKey), "the key is not in the report");
		assert.deepEqual(Object.keys(summarize(results)).sort(), ["failed", "ms", "passed", "skipped"]);
	});

	test("an account with no newsletter yet skips the newsletter-scoped reads with the reason and fails nothing", async () => {
		const results = await runSmoke({ baseUrl: APP_URL, apiKey: empty.fullKey, level: "full", fetchImpl: appFetch });
		assert.deepEqual(failures(results), [], formatResults(results));
		const scoped = ["REST GET /reader-settings", "REST GET /reply-rules", "REST GET /mailing-lists", "REST GET /authors", "REST GET /perks", "REST GET /creator-matches/settings"];
		for (const name of scoped) {
			const result = results.find((entry) => entry.name === name);
			assert.ok(result, `${name} is a check`);
			assert.equal(result.skipped, true, name);
			assert.match(result.detail, /no newsletter yet \(404: Create a newsletter first\)/);
		}
		assert.equal(results.find(({ name }) => name === "REST GET /newsletters").ok, true);
	});

	test("the same 404 on an account that has a newsletter, or another 404 on one that has none, stays a failure", async () => {
		const notFound = (message) => Response.json({ error: { code: "not_found", message } }, { status: 404 });
		const replace = (message) => async (input, init) => (new URL(input).pathname === "/api/v1/reader-settings" && init.headers.authorization ? notFound(message) : appFetch(input, init));
		const withNewsletter = await runSmoke({ baseUrl: APP_URL, apiKey: owner.fullKey, fetchImpl: replace("Create a newsletter first") });
		const readerSettings = withNewsletter.find(({ name }) => name === "REST GET /reader-settings");
		assert.equal(readerSettings.ok, false);
		assert.match(readerSettings.detail, /answered 404 instead of 200/);
		const other = await runSmoke({ baseUrl: APP_URL, apiKey: empty.fullKey, fetchImpl: replace("Newsletter not found") });
		assert.equal(other.find(({ name }) => name === "REST GET /reader-settings").ok, false);
		const brokenList = async (input, init) => (new URL(input).pathname === "/api/v1/newsletters" && init.headers.authorization ? new Response("down", { status: 502 }) : replace("Create a newsletter first")(input, init));
		const unknown = await runSmoke({ baseUrl: APP_URL, apiKey: empty.fullKey, fetchImpl: brokenList });
		assert.equal(unknown.find(({ name }) => name === "REST GET /reader-settings").ok, false, "a failed list_newsletters does not prove the account is empty");
	});

	test("a read only key skips the admin reads, expects its own tool count and fails nothing", async () => {
		const results = await runSmoke({ baseUrl: APP_URL, apiKey: owner.readKey, level: "read_only", fetchImpl: appFetch });
		assert.deepEqual(failures(results), [], formatResults(results));
		const skipped = results.filter(({ skipped: wasSkipped }) => wasSkipped).map(({ name }) => name);
		assert.ok(skipped.includes("REST GET /billing") && skipped.includes("REST GET /api-keys") && skipped.includes("REST GET /team"));
		assert.match(results.find(({ name }) => name.startsWith("MCP tools/list")).detail, new RegExp(`^${expectedTools("read_only").length} tools, expected ${expectedTools("read_only").length};`));
		assert.ok(expectedTools("read_only").length < expectedTools("full").length);
	});

	test("a key of the wrong level for its declared level shows as a count mismatch, not a crash", async () => {
		const results = await runSmoke({ baseUrl: APP_URL, apiKey: owner.readKey, level: "full", fetchImpl: appFetch });
		const tools = results.find(({ name }) => name.startsWith("MCP tools/list"));
		assert.equal(tools.ok, false);
		assert.match(tools.detail, /missing /);
		assert.ok(failures(results).some(({ name }) => name === "REST GET /billing"), "the admin read is refused with 403");
	});

	test("a wrong key fails every authenticated check and reports the status, not the key", async () => {
		const results = await runSmoke({ baseUrl: APP_URL, apiKey: "mc_wrong_key_value", level: "full", fetchImpl: appFetch });
		assert.equal(results[0].ok, true, "the unauthenticated check still passes");
		assert.equal(failures(results).length + results.filter(({ skipped }) => skipped).length, results.length - 1);
		assert.ok(failures(results).length >= CHECKS.length - 3);
		assert.match(failures(results)[0].detail, /answered 401 instead of 200/);
		assert.ok(!JSON.stringify(results).includes("mc_wrong_key_value"));
	});

	test("an answer of the wrong shape, a router's 502 and a request that throws are each a failed check", async () => {
		const wrongShape = await runSmoke({ baseUrl: APP_URL, apiKey: owner.fullKey, fetchImpl: async (input, init) => (new URL(input).pathname === "/api/v1/newsletters" && init.headers.authorization ? Response.json({ items: [] }) : appFetch(input, init)) });
		assert.equal(wrongShape.find(({ name }) => name === "REST GET /newsletters").detail, "no newsletters in the answer");
		const down = await runSmoke({ baseUrl: APP_URL, apiKey: owner.fullKey, fetchImpl: async () => new Response("The app is not answering.\n", { status: 502 }) });
		assert.equal(failures(down).length + down.filter(({ skipped }) => skipped).length, down.length);
		assert.match(failures(down)[1].detail, /answered 502 instead of 200 "The app is not answering/);
		const secret = "mc_secret_that_must_not_appear";
		const throwing = await runSmoke({ baseUrl: APP_URL, apiKey: secret, fetchImpl: async () => { throw new Error(`socket closed for Bearer ${secret}`); } });
		assert.match(failures(throwing)[0].detail, /the request failed: socket closed for Bearer \[key\]/);
		assert.ok(!JSON.stringify(throwing).includes(secret));
	});

	test("it sent nothing but GET to the REST API and tools/call only for reads", async () => {
		const seen = [];
		await runSmoke({ baseUrl: APP_URL, apiKey: owner.fullKey, fetchImpl: async (input, init) => {
			const body = init.body ? JSON.parse(init.body) : null;
			seen.push({ method: init.method, path: new URL(input).pathname, rpc: body?.method, tool: body?.params?.name });
			return appFetch(input, init);
		} });
		const rest = seen.filter(({ path }) => path.startsWith("/api/v1/"));
		assert.ok(rest.length > 20);
		assert.ok(rest.every(({ method }) => method === "GET"));
		assert.ok(seen.filter(({ path }) => path === "/mcp").every(({ method, rpc }) => method === "POST" && ["initialize", "tools/list", "tools/call"].includes(rpc)));
		const tools = seen.filter(({ rpc }) => rpc === "tools/call").map(({ tool }) => tool);
		assert.ok(tools.length >= 5);
		assert.ok(tools.every((name) => isSmokeRead(name)), tools.join(", "));
	});
});

describe("the checks match the registry", () => {
	test("every check is a public GET read whose answer has the keys it expects", async () => {
		const { ACTIONS } = await import("../lib/actions/registry.js");
		for (const check of CHECKS) {
			const action = ACTIONS.find(({ name }) => name === check.action);
			assert.ok(action, `${check.action} is in the registry`);
			assert.equal(action.readOnly, true, `${check.action} is readOnly`);
			assert.equal(action.http.method, "GET");
			assert.ok(isSmokeRead(check.action), `${check.action} may be smoked`);
			const shape = action.output.shape;
			for (const key of check.keys) {
				const name = key.replace(/\[\]$/, "");
				assert.ok(name in shape, `${check.action} answers with ${name}`);
				if (key.endsWith("[]")) assert.equal(shape[name]._zod.def.type, "array", `${check.action}.${name} is a list`);
			}
			const required = Object.entries(action.input?.shape ?? {}).filter(([, field]) => !field.isOptional()).map(([name]) => name);
			const given = new Set([...Object.keys(check.query?.() ?? {}), ...(check.needsNewsletter ? ["id"] : [])]);
			assert.deepEqual(required.filter((name) => !given.has(name)), [], `${check.action} gets what it requires`);
		}
	});

	test("the tool names the script expects are exactly the registry's public actions", async () => {
		const { ACTIONS } = await import("../lib/actions/registry.js");
		assert.deepEqual(expectedTools("full").sort(), ACTIONS.filter(({ dashboardOnly }) => !dashboardOnly).map(({ name }) => name).sort());
	});
});

describe("the read-only guard", () => {
	const listed = (names, readOnlyHint = true) => new Map(names.map((name) => [name, { name, annotations: { readOnlyHint } }]));

	test("refuses every REST method but GET before any request exists", () => {
		for (const method of ["POST", "PATCH", "PUT", "DELETE", "post", "OPTIONS", "HEAD"]) {
			assert.throws(() => assertReadOnlyRest(method, "/api/v1/newsletters"), ReadOnlyViolation, method);
		}
		assert.equal(assertReadOnlyRest("GET", "/api/v1/newsletters").name, "list_newsletters");
		assert.equal(assertReadOnlyRest("get", "/api/v1/campaigns?limit=5").name, "list_campaigns");
		assert.equal(assertReadOnlyRest("GET", "/api/v1/newsletters/abc123/groups/settings").name, "get_group_settings");
	});

	test("refuses paths outside /api/v1, unknown paths and reads of contact data or access links", () => {
		for (const path of ["/mcp", "/api/auth/get-session", "/api/v1/nonexistent", "/api/v1/contacts", "/api/v1/contacts/abc", "/api/v1/replies", "/api/v1/account/export", "https://evil.example/api/v1/newsletters"]) {
			assert.throws(() => assertReadOnlyRest("GET", path), ReadOnlyViolation, path);
		}
	});

	test("refuses a GET path that only matches a write: the guard follows the registry, not the verb", () => {
		const writes = ACTION_MANIFEST.filter(([, , method, , , dashboardOnly]) => method !== "GET" && !dashboardOnly);
		assert.ok(writes.length > 100);
		for (const [name, , , path] of writes.slice(0, 400)) {
			const concrete = `/api/v1${path.replace(/\{[^}]+\}/g, "abc")}`;
			const entry = (() => { try { return assertReadOnlyRest("GET", concrete); } catch { return null; } })();
			if (entry) assert.equal(entry.method, "GET", `${name} at ${concrete} resolved to ${entry.name}`);
		}
	});

	test("refuses every MCP tool that is not a read, however the server annotates it", () => {
		const everything = ACTION_MANIFEST.map(([name]) => name);
		const refusedTools = [];
		for (const name of everything) {
			try {
				assertReadOnlyTool(name, listed(everything, true));
			} catch (error) {
				assert.ok(error instanceof ReadOnlyViolation);
				refusedTools.push(name);
			}
		}
		for (const name of ["send_campaign", "delete_contact", "create_api_key", "update_newsletter", "import_contacts", "create_campaign", "decide_approval", "export_contacts", "list_contacts", "get_account_export"]) {
			assert.ok(refusedTools.includes(name) || !everything.includes(name), `${name} is refused`);
		}
		for (const name of refusedTools) assert.ok(!isSmokeRead(name));
		const allowed = everything.filter((name) => !refusedTools.includes(name));
		assert.ok(allowed.length >= CHECKS.length);
		for (const name of allowed) {
			const [, , method] = ACTION_MANIFEST.find(([entry]) => entry === name);
			assert.equal(method, "GET", `${name} is allowed and is a GET`);
		}
	});

	test("refuses a read the server does not list, or lists without readOnlyHint, or that is on the never list", () => {
		assert.throws(() => assertReadOnlyTool("list_newsletters", listed([])), /did not list it/);
		assert.throws(() => assertReadOnlyTool("list_newsletters", listed(["list_newsletters"], false)), /does not mark it readOnlyHint/);
		assert.throws(() => assertReadOnlyTool("list_newsletters", null), /did not list it/);
		assert.throws(() => assertReadOnlyTool("list_contacts", listed(["list_contacts"])), /not a read/);
		assert.ok(assertReadOnlyTool("get_billing", listed(["get_billing"])), "an admin-class read that only looks is allowed");
		assert.ok(!isSmokeRead("rotate_api_key") && !isSmokeRead("not_an_action"));
	});

	test("an MCP server that lists a write tool as a read still never gets a call to it", async () => {
		const called = [];
		const lying = async (input, init) => {
			const body = JSON.parse(init.body ?? "{}");
			if (body.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "send_campaign", annotations: { readOnlyHint: true } }, { name: "list_newsletters", annotations: { readOnlyHint: true } }] } });
			if (body.method) called.push(body.params?.name ?? body.method);
			return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
		};
		const results = await runSmoke({ baseUrl: APP_URL, apiKey: "mc_x", fetchImpl: lying });
		assert.ok(results.length > 0);
		assert.ok(!called.includes("send_campaign"));
		assert.ok(called.includes("list_newsletters"));
	});

	test("shapeProblem names what is missing", () => {
		assert.equal(shapeProblem({ a: [], b: 1 }, ["a[]", "b"]), null);
		assert.equal(shapeProblem({ a: {} }, ["a[]"]), "a is not a list");
		assert.equal(shapeProblem({}, ["a"]), "no a in the answer");
		assert.equal(shapeProblem([], ["a"]), "the answer is not a JSON object");
		assert.equal(shapeProblem(null, ["a"]), "the answer is not a JSON object");
	});
});

describe("the command", () => {
	const run = (args, env = {}) => spawnSync("node", ["scripts/smoke-live.mjs", ...args], { cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH, ...env } });

	test("needs an address, a key in the environment and https, and exits 2 otherwise", () => {
		assert.equal(run([]).status, 2);
		assert.match(run([]).stderr, /usage: FLOCKSTACK_API_KEY/);
		assert.equal(run(["not a url"], { FLOCKSTACK_API_KEY: "mc_x" }).status, 2);
		const noKey = run(["https://flockstack.io"]);
		assert.equal(noKey.status, 2);
		assert.match(noKey.stderr, /FLOCKSTACK_API_KEY is not set/);
		const http = run(["http://flockstack.io"], { FLOCKSTACK_API_KEY: "mc_x" });
		assert.equal(http.status, 2);
		assert.match(http.stderr, /must be https/);
		assert.equal(run(["https://flockstack.io", "--level", "signups"], { FLOCKSTACK_API_KEY: "mc_x" }).status, 2);
	});

	test("takes no key as an argument, and never echoes the one it has", () => {
		const asArgument = run(["mc_abcdef123456"], { FLOCKSTACK_API_KEY: "mc_other" });
		assert.equal(asArgument.status, 2);
		assert.ok(!asArgument.stderr.includes("mc_abcdef123456"));
		const key = "mc_value_from_the_environment";
		const result = run(["http://127.0.0.1:9"], { FLOCKSTACK_API_KEY: key });
		assert.equal(result.status, 1, "a refused connection is a failed check");
		assert.ok(!result.stdout.includes(key) && !result.stderr.includes(key));
		assert.match(result.stdout, /FAIL/);
	});
});
