import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { as, form, startTestApp } from "./helpers/app.mjs";
import { APP_URL, createOAuthHarness, loadOAuthRoutes } from "./helpers/oauth-flow.mjs";
import { forgetAuth } from "../lib/auth.js";
import { formatResults, runChecks } from "../scripts/check-mcp-auth.mjs";

// scripts/check-mcp-auth.mjs against the app's own routes: what it takes for a pass, and what each failure looks like.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
let app;
let h;
let key;

before(async () => {
	app = await startTestApp();
	const m = await loadOAuthRoutes();
	h = createOAuthHarness(m);
	const user = await h.customer("check-mcp@example.com");
	const { activate } = await import("./helpers/app.mjs");
	await activate(user);
	const apiKeys = await import("../app/(app)/api-keys/actions.js");
	key = (await as(user, () => apiKeys.createApiKey(null, form({ name: "Check", level: "read_only" })))).key;
});

after(() => app?.stop());

const failures = (results) => results.filter(({ ok }) => !ok);

describe("against the app", () => {
	test("passes without credentials, and with an API key lists the tools too", async () => {
		const results = await runChecks({ baseUrl: APP_URL, fetchImpl: h.appFetch });
		assert.deepEqual(failures(results), [], formatResults(results));
		assert.equal(results.length, 5, "the two documents of the protected resource, the authorization server, the keys and /mcp");
		const withKey = await runChecks({ baseUrl: APP_URL, apiKey: key, fetchImpl: h.appFetch });
		assert.deepEqual(failures(withKey), [], formatResults(withKey));
		assert.equal(withKey.length, 6);
		assert.ok(!formatResults(withKey).includes(key), "the key is not in the report");
	});

	test("still passes after BETTER_AUTH_SECRET changed with nothing to read the signing key with: the keys are public", async () => {
		const original = process.env.BETTER_AUTH_SECRET;
		process.env.BETTER_AUTH_SECRET = "another-secret-for-the-synthetic-check-0123456789";
		forgetAuth();
		try {
			const results = await runChecks({ baseUrl: APP_URL, fetchImpl: h.appFetch });
			assert.deepEqual(failures(results), [], formatResults(results));
		} finally {
			process.env.BETTER_AUTH_SECRET = original;
			forgetAuth();
		}
	});
});

describe("what failing looks like", () => {
	const answers = (overrides) => async (input, init) => {
		const url = new URL(input);
		for (const [prefix, answer] of Object.entries(overrides)) if (url.pathname === prefix) return typeof answer === "function" ? answer(input, init) : answer;
		return h.appFetch(input, init);
	};

	test("the router's 502 is named, with the start of its body", async () => {
		const down = new Response("The app is not answering. Try again in a moment.\n", { status: 502 });
		const results = await runChecks({ baseUrl: APP_URL, fetchImpl: async () => down.clone() });
		assert.equal(failures(results).length, results.length);
		assert.match(failures(results)[0].detail, /answered 502 instead of 200: "The app is not answering/);
	});

	test("a request that throws or hangs is a failed check, not an exception", async () => {
		const results = await runChecks({ baseUrl: APP_URL, fetchImpl: async () => { throw new Error("connection reset"); } });
		assert.equal(failures(results).length, results.length);
		assert.match(failures(results)[0].detail, /the request failed: connection reset/);
	});

	test("a signing key with a private part, an empty list, and a /mcp that answers without a challenge each fail on their own", async () => {
		const leaking = await runChecks({ baseUrl: APP_URL, fetchImpl: answers({ "/api/auth/jwks": Response.json({ keys: [{ kid: "a", kty: "RSA", alg: "RS256", n: "x", e: "AQAB", d: "secret" }] }) }) });
		assert.deepEqual(failures(leaking).map(({ detail }) => detail), ["a key carries a private part"]);
		const empty = await runChecks({ baseUrl: APP_URL, fetchImpl: answers({ "/api/auth/jwks": Response.json({ keys: [] }) }) });
		assert.deepEqual(failures(empty).map(({ detail }) => detail), ["no keys listed"]);
		const bare = await runChecks({ baseUrl: APP_URL, fetchImpl: answers({ "/mcp": Response.json({ error: { code: "unauthorized" } }, { status: 401 }) }) });
		assert.match(failures(bare)[0].detail, /not a Bearer challenge/);
		const wrongHost = await runChecks({ baseUrl: APP_URL, fetchImpl: answers({ "/mcp": Response.json({ error: { code: "unauthorized" } }, { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://other.example.com/.well-known/oauth-protected-resource/mcp"' } }) }) });
		assert.match(failures(wrongHost)[0].detail, /does not name http:\/\/localhost:3000\/\.well-known/);
	});

	test("a refused API key is a failure of the authenticated check only", async () => {
		const results = await runChecks({ baseUrl: APP_URL, apiKey: "mc_wrong", fetchImpl: h.appFetch });
		assert.deepEqual(failures(results).map(({ name }) => name), ["/mcp with FLOCKSTACK_API_KEY: tools/list"]);
		assert.match(failures(results)[0].detail, /answered 401 instead of 200/);
	});
});

describe("the command", () => {
	test("needs a URL, and exits 2 without one", () => {
		const result = spawnSync("node", ["scripts/check-mcp-auth.mjs"], { cwd: ROOT, encoding: "utf8" });
		assert.equal(result.status, 2);
		assert.match(result.stderr, /usage: node scripts\/check-mcp-auth.mjs/);
		assert.equal(spawnSync("node", ["scripts/check-mcp-auth.mjs", "not a url"], { cwd: ROOT, encoding: "utf8" }).status, 2);
	});
});
