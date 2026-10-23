import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { fetchClientMetadataResourceOnWorkers, getClientMetadataFetcher, isPublicClientHostname, isWorkersRuntime } from "../lib/cimd-fetch.js";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("which hosts a client_id may name", () => {
	test("accepts a public name and refuses addresses, bare names and names inside a network", () => {
		for (const ok of ["claude.ai", "client.example.com", "a.b.example.org."]) assert.equal(isPublicClientHostname(ok), true, ok);
		for (const bad of ["localhost", "127.0.0.1", "10.0.0.5", "169.254.169.254", "[::1]", "intranet", "printer.local", "db.internal", "x.localhost", "", undefined]) {
			assert.equal(isPublicClientHostname(bad), false, String(bad));
		}
	});
});

describe("the Worker's metadata fetcher", () => {
	test("asks for the document without following redirects and hands the answer back", async () => {
		const seen = [];
		globalThis.fetch = async (request, init) => {
			seen.push({ url: request.url, method: request.method, init });
			return new Response('{"client_id":"https://claude.ai/oauth/claude-code-client-metadata"}', { status: 200, headers: { "content-type": "application/json" } });
		};
		const response = await fetchClientMetadataResourceOnWorkers("https://claude.ai/oauth/claude-code-client-metadata", { headers: { accept: "application/json" } });
		assert.equal(response.status, 200);
		assert.equal(seen.length, 1);
		assert.equal(seen[0].url, "https://claude.ai/oauth/claude-code-client-metadata");
		assert.equal(seen[0].init.redirect, "manual");
	});

	test("hands a redirect back instead of following it", async () => {
		globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/metadata" } });
		const response = await fetchClientMetadataResourceOnWorkers("https://client.example.com/meta");
		assert.equal(response.status, 302);
	});

	test("refuses http, other methods and hosts that are not public names, without fetching", async () => {
		let calls = 0;
		globalThis.fetch = async () => {
			calls += 1;
			return new Response("{}");
		};
		await assert.rejects(fetchClientMetadataResourceOnWorkers("http://claude.ai/meta"), /HTTPS/);
		await assert.rejects(fetchClientMetadataResourceOnWorkers("https://claude.ai/meta", { method: "POST", body: "x" }), /only GET and HEAD/);
		await assert.rejects(fetchClientMetadataResourceOnWorkers("https://127.0.0.1/meta"), /public name/);
		await assert.rejects(fetchClientMetadataResourceOnWorkers("https://metadata.internal/meta"), /public name/);
		assert.equal(calls, 0);
	});
});

describe("choosing the fetcher", () => {
	test("is the Worker's on Cloudflare and the package's pinned Node one elsewhere", async () => {
		assert.equal(isWorkersRuntime(), false);
		const node = await getClientMetadataFetcher();
		assert.notEqual(node, fetchClientMetadataResourceOnWorkers);
		const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
		Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Cloudflare-Workers" }, configurable: true });
		try {
			assert.equal(isWorkersRuntime(), true);
			assert.equal(await getClientMetadataFetcher(), fetchClientMetadataResourceOnWorkers);
		} finally {
			if (original) Object.defineProperty(globalThis, "navigator", original);
			else delete globalThis.navigator;
		}
	});
});
