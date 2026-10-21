import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { ALIASES, buildApiWorker } from "../scripts/build-api-worker.mjs";

// scripts/build-api-worker.mjs: the lean API Worker is one ES module with the shared source in it and nothing of Next.js or React.
// The built file is loaded and asked for answers, so what runs is what Wrangler uploads.
let folder;
let outFile;
let source;
let worker;

before(async () => {
	folder = mkdtempSync(join(tmpdir(), "flockstack-api-build-"));
	outFile = join(folder, "index.js");
	const built = await buildApiWorker({ outFile, metafile: true });
	assert.equal(built.outFile, outFile);
	source = readFileSync(outFile, "utf8");
	process.env.FLOCKSTACK_SQLITE = ":memory:";
	Object.assign(process.env, { BETTER_AUTH_SECRET: "test-secret-for-integration-tests-0123456789", SUPPRESSION_HASH_KEY: "test-suppression-hash-key-0123456789abcdef", FLOCKSTACK_CLOUD: "true", APP_URL: "https://flockstack.io" });
	worker = (await import(pathToFileURL(outFile).href)).default;
});

after(() => {
	delete process.env.FLOCKSTACK_SQLITE;
	rmSync(folder, { recursive: true, force: true });
});

describe("the built API Worker", () => {
	test("has no Next.js, React or server component code in it, and its adapters are the only stand-ins", () => {
		const meta = JSON.parse(readFileSync(`${outFile}.meta.json`, "utf8"));
		const inputs = Object.keys(Object.values(meta.outputs)[0].inputs);
		for (const input of inputs) {
			assert.doesNotMatch(input, /node_modules\/(next|react|react-dom|scheduler|@opennextjs)\//, input);
			assert.doesNotMatch(input, /^(app\/.*\.jsx|components\/)/, input);
		}
		assert.ok(inputs.includes("workers/api/runtime-hooks.js"), "lib/runtime-hooks.js is replaced by the Worker's");
		assert.ok(!inputs.includes("lib/runtime-hooks.js"));
		for (const name of Object.keys(ALIASES)) assert.ok(typeof ALIASES[name] === "string");
		assert.doesNotMatch(source, /from"next\/|from "next\/|require\("next|react-dom/);
	});

	test("has no character above U+00FF, so V8 holds its source at one byte a character, and is a fraction of the app's 37 MB", () => {
		const wide = source.search(/[^\x00-\xff]/);
		assert.equal(wide, -1, `a character above U+00FF at ${wide}: ${JSON.stringify(source.slice(Math.max(0, wide - 30), wide + 10))}`);
		assert.ok(statSync(outFile).size < 9_000_000, `${statSync(outFile).size} bytes`);
	});

	test("answers requests: the OpenAPI document, a refusal without a key, discovery and the MCP challenge", async () => {
		const ctx = { waitUntil() {} };
		const env = { DB: {} };
		const openapi = await worker.fetch(new Request("https://flockstack.io/api/v1/openapi.json"), env, ctx);
		assert.equal(openapi.status, 200);
		assert.equal((await openapi.json()).openapi, "3.1.0");
		const refused = await worker.fetch(new Request("https://flockstack.io/api/v1/contacts"), env, ctx);
		assert.equal(refused.status, 401);
		assert.equal(refused.headers.get("www-authenticate"), 'Bearer realm="FlockStack"');
		assert.match(refused.headers.get("x-frame-options"), /DENY/);
		const mcp = await worker.fetch(new Request("https://flockstack.io/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" }), env, ctx);
		assert.equal(mcp.status, 401);
		assert.match(mcp.headers.get("www-authenticate"), /resource_metadata="https:\/\/flockstack\.io\/\.well-known\/oauth-protected-resource\/mcp"/);
		const discovery = await worker.fetch(new Request("https://flockstack.io/.well-known/oauth-authorization-server"), env, ctx);
		assert.equal(discovery.status, 200);
		assert.equal((await discovery.json()).token_endpoint, "https://flockstack.io/api/auth/oauth2/token");
	});
});
