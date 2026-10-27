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
	// As the Worker that is deployed is built: the FlockStack Cloud build, which perf-budgets.json measures.
	const original = process.env.FLOCKSTACK_CLOUD_BUILD;
	process.env.FLOCKSTACK_CLOUD_BUILD = "true";
	let built;
	try {
		built = await buildApiWorker({ outFile, metafile: true });
	} finally {
		if (original === undefined) delete process.env.FLOCKSTACK_CLOUD_BUILD;
		else process.env.FLOCKSTACK_CLOUD_BUILD = original;
	}
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

// What a module loads when it loads, before anything it imports on demand: the static closure of an entry in esbuild's metafile.
function staticClosure(meta, entry) {
	const seen = new Set();
	const visit = (file) => {
		if (seen.has(file) || !meta.inputs[file]) return;
		seen.add(file);
		for (const item of meta.inputs[file].imports) if (item.kind === "import-statement" || item.kind === "require-call") visit(item.path);
	};
	visit(entry);
	return seen;
}

describe("what a request loads", () => {
	test("the REST route and the MCP route load no file of actions, no registry and no Better Auth until a request needs them", async () => {
		const { ACTION_FILES } = await import("../lib/actions/groups.js");
		const actionFiles = Object.keys(ACTION_FILES).map((file) => `lib/actions/${file}.js`);
		for (const entry of ["app/api/v1/[...path]/route.js", "app/mcp/route.js"]) {
			const out = join(folder, "light.js");
			await buildApiWorker({ outFile: out, metafile: true, entry: join(process.cwd(), entry) });
			const closure = staticClosure(JSON.parse(readFileSync(`${out}.meta.json`, "utf8")), entry);
			const bad = [...closure].filter((file) => actionFiles.includes(file) || ["lib/actions/registry.js", "lib/auth.js", "lib/oauth.js", "lib/docs/openapi.js"].includes(file) || /node_modules\/(better-auth|@better-auth|stripe|@aws-sdk)\//.test(file));
			assert.deepEqual(bad, [], `${entry} loads ${bad.slice(0, 5).join(", ")}`);
			assert.ok(closure.has("lib/actions/lazy.js"));
		}
	});
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
		const limit = JSON.parse(readFileSync(new URL("../perf-budgets.json", import.meta.url), "utf8")).budgets["api-worker"].maxBytes;
		assert.ok(statSync(outFile).size <= limit, `${statSync(outFile).size} bytes exceeds the measured API budget ${limit}`);
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
