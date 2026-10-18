import assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";

// lib/cloudflare-api.js itself, against a fetch that answers like Cloudflare's API. Every other test gets the stub.
const ZONE = "zone_saas_test";
let api;
let requests = [];
let answers = [];
const fetch = globalThis.fetch;

function answer(...items) {
	answers.push(...items);
}

function ok(result) {
	return { status: 200, body: { success: true, errors: [], result } };
}

function refused(status, code, message) {
	return { status, body: { success: false, errors: [{ code, message }], result: null } };
}

before(async () => {
	process.env.CLOUDFLARE_API_TOKEN = "test-cloudflare-token";
	api = await import("../lib/cloudflare-api.js");
	globalThis.fetch = async (input, init = {}) => {
		const url = new URL(String(input));
		requests.push({ method: init.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: init.body ? JSON.parse(init.body) : null, headers: init.headers, signal: init.signal });
		const next = answers.shift();
		if (!next) throw new Error(`Unexpected request ${init.method} ${url.pathname}`);
		if (next instanceof Error) throw next;
		return Response.json(next.body, { status: next.status });
	};
});

afterEach(() => {
	assert.equal(answers.length, 0, "every answer was asked for");
	requests = [];
	answers = [];
});

after(() => {
	globalThis.fetch = fetch;
	delete process.env.CLOUDFLARE_API_TOKEN;
});

describe("requests", () => {
	test("go to the v4 API with the token, read when called, and a timeout", async () => {
		answer(ok([]));
		await api.listWorkerRoutes(ZONE);
		const [request] = requests;
		assert.equal(request.path, `/client/v4/zones/${ZONE}/workers/routes`);
		assert.equal(request.headers.authorization, "Bearer test-cloudflare-token");
		assert.ok(request.signal instanceof AbortSignal);

		delete process.env.CLOUDFLARE_API_TOKEN;
		try {
			assert.equal(api.isCloudflareConfigured(), false);
			await assert.rejects(api.listWorkerRoutes(ZONE), (error) => error.isAuth && requests.length === 1, "nothing sent without a token");
		} finally {
			process.env.CLOUDFLARE_API_TOKEN = "test-cloudflare-token";
		}
	});

	test("Cloudflare's errors keep their codes, and say what kind they are", async () => {
		answer(refused(403, 10000, "Authentication error"));
		await assert.rejects(api.listDnsRecords(ZONE, { name: "a.example.com" }), (error) => {
			assert.equal(error.message, `Cloudflare refused GET /zones/${ZONE}/dns_records: Authentication error (10000)`);
			assert.deepEqual([error.status, error.codes, error.isAuth, error.isRateLimited, error.isUnavailable], [403, [10000], true, false, false]);
			return true;
		});
		answer(refused(400, 9109, "Invalid access token"));
		await assert.rejects(api.listDnsRecords(ZONE), (error) => error.isAuth && error.status === 400);
		answer(refused(429, 971, "Please wait and consider throttling your request speed"));
		await assert.rejects(api.listDnsRecords(ZONE), (error) => error.isRateLimited && !error.isUnavailable);
		assert.equal(requests.length, 3, "a rate limit isn't tried again");
	});

	test("no answer and Cloudflare's 5xx are tried again, twice", async () => {
		answer(new TypeError("fetch failed"), refused(502, 1500, "Internal Server Error"), ok([{ id: "route_1", pattern: "news.example.com/*", script: "flockstack" }]));
		assert.deepEqual(await api.listWorkerRoutes(ZONE), [{ id: "route_1", pattern: "news.example.com/*", script: "flockstack" }]);
		assert.equal(requests.length, 3);

		answer(new TypeError("fetch failed"), new TypeError("fetch failed"), Object.assign(new Error("timed out"), { name: "TimeoutError" }));
		await assert.rejects(api.listWorkerRoutes(ZONE), (error) => {
			assert.equal(error.message, `Cloudflare didn't answer GET /zones/${ZONE}/workers/routes: no answer in 15 s`);
			assert.equal(error.isUnavailable, true);
			return true;
		});
	});
});

describe("idempotent writes", () => {
	test("a custom hostname that exists already is found and returned", async () => {
		const ssl = { method: "http", type: "dv" };
		answer(ok({ id: "ch_1", hostname: "news.example.com", status: "pending", ssl: { status: "initializing" } }));
		assert.equal((await api.createCustomHostname(ZONE, "news.example.com", ssl)).existed, false);
		assert.deepEqual(requests[0].body, { hostname: "news.example.com", ssl });

		answer(refused(409, 1406, "Duplicate custom hostname found."), ok([{ id: "ch_1", hostname: "news.example.com", status: "active" }]));
		const again = await api.createCustomHostname(ZONE, "news.example.com", ssl);
		assert.deepEqual([again.id, again.existed], ["ch_1", true]);
		assert.deepEqual(requests.at(-1).query, { hostname: "news.example.com", per_page: "5" });
	});

	test("a route with the same pattern counts as made, with the Worker it names", async () => {
		answer(refused(409, 10020, "A route with the same pattern already exists"), ok([{ id: "route_9", pattern: "news.example.com/*", script: "flockstack-eu" }]));
		assert.deepEqual(await api.createWorkerRoute(ZONE, { pattern: "news.example.com/*", script: "flockstack" }), {
			id: "route_9",
			pattern: "news.example.com/*",
			script: "flockstack-eu",
			existed: true,
		});
		answer(refused(403, 10000, "Authentication error"));
		await assert.rejects(api.createWorkerRoute(ZONE, { pattern: "x.example.com/*", script: "flockstack" }), (error) => error.isAuth, "no lookup on a token problem");
	});

	test("the same DNS record again is the one there, quotes or not; a conflict is left to the caller", async () => {
		const record = { type: "TXT", name: "bounce.weekly.example.com", content: "v=spf1 include:amazonses.com ~all", ttl: 1 };
		answer(
			refused(400, 81058, "A record with the same settings already exists."),
			ok([
				{ id: "dns_other", type: "TXT", name: record.name, content: '"something else"' },
				{ id: "dns_1", type: "TXT", name: record.name, content: `"${record.content}"` },
			])
		);
		const existing = await api.createDnsRecord(ZONE, record);
		assert.deepEqual([existing.id, existing.existed], ["dns_1", true]);
		assert.deepEqual(requests.at(-1).query, { per_page: "100", name: record.name, type: "TXT" });

		answer(refused(400, 81053, "An A, AAAA, or CNAME record with that host already exists."));
		await assert.rejects(api.createDnsRecord(ZONE, { type: "CNAME", name: "weekly.example.com", content: "sites.example.com" }), (error) => error.isConflict);
	});

	test("deleting what's gone already is done", async () => {
		answer(refused(404, 81044, "Record does not exist."), ok({ id: "route_1" }), refused(404, 1436, "Custom hostname not found"));
		assert.deepEqual(await api.deleteDnsRecord(ZONE, "dns_gone"), { deleted: false });
		assert.deepEqual(await api.deleteWorkerRoute(ZONE, "route_1"), { deleted: true });
		assert.deepEqual(await api.deleteCustomHostname(ZONE, "ch_gone"), { deleted: false });
		assert.deepEqual(requests.map(({ method, path }) => `${method} ${path}`), [
			`DELETE /client/v4/zones/${ZONE}/dns_records/dns_gone`,
			`DELETE /client/v4/zones/${ZONE}/workers/routes/route_1`,
			`DELETE /client/v4/zones/${ZONE}/custom_hostnames/ch_gone`,
		]);
		answer(refused(404, 1436, "Custom hostname not found"));
		assert.equal(await api.getCustomHostname(ZONE, "ch_gone"), null);
	});
});

test("the module reads nothing and makes nothing random when it loads", async () => {
	const { readFile } = await import("node:fs/promises");
	const source = await readFile(new URL("../lib/cloudflare-api.js", import.meta.url), "utf8");
	assert.doesNotMatch(source, /from "node:|require\(|Math\.random|crypto\./);
	assert.doesNotMatch(source.replace(/function [\s\S]*?\n}\n/g, ""), /process\.env/, "env is read inside functions only");
});
