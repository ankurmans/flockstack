import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { main, parseArgs, planMoves } from "../scripts/route-archive-hosts.mjs";

// scripts/route-archive-hosts.mjs: which routes move between a region's app Worker and its router, and that nothing moves without --apply.
const ROUTES = [
	{ id: "r1", pattern: "news.example.com/*", script: "flockstack" },
	{ id: "r2", pattern: "weekly.example.org/*", script: "flockstack-eu" },
	{ id: "r3", pattern: "*.flockstackmail.com/*", script: "flockstack" },
	{ id: "r4", pattern: "img.flockstack.io/*", script: null },
	{ id: "r5", pattern: "other.example.com/*", script: "someone-elses-worker" },
];

describe("planning", () => {
	test("to the router: the routes that name an app Worker move to that region's router, patterns kept, the rest are left alone", () => {
		const { moves, left } = planMoves(ROUTES, { to: "router" });
		assert.deepEqual(moves.map(({ pattern, to }) => [pattern, to]), [["news.example.com/*", "flockstack-router"], ["weekly.example.org/*", "flockstack-router-eu"], ["*.flockstackmail.com/*", "flockstack-router"]]);
		assert.deepEqual(left.map(({ pattern }) => pattern), ["img.flockstack.io/*", "other.example.com/*"]);
	});

	test("back to the app is the reverse, and --only keeps to one region", () => {
		const routed = ROUTES.map((route) => ({ ...route, script: route.script === "flockstack" ? "flockstack-router" : route.script === "flockstack-eu" ? "flockstack-router-eu" : route.script }));
		assert.deepEqual(planMoves(routed, { to: "app" }).moves.map(({ to }) => to), ["flockstack", "flockstack-eu", "flockstack"]);
		assert.deepEqual(planMoves(routed, { to: "app", only: "eu" }).moves.map(({ pattern }) => pattern), ["weekly.example.org/*"]);
		assert.equal(planMoves(ROUTES, { to: "app" }).moves.length, 0, "nothing to move back that is not at a router");
	});
});

describe("running", () => {
	function api(routes = ROUTES) {
		const calls = [];
		const fetchImpl = async (url, init) => {
			calls.push({ method: init.method, url: String(url), body: init.body ? JSON.parse(init.body) : null, authorization: init.headers.authorization });
			if (init.method === "GET") return Response.json({ success: true, result: routes });
			return Response.json({ success: true, result: {} });
		};
		return { calls, fetchImpl };
	}
	const env = { CLOUDFLARE_API_TOKEN: "token", CLOUDFLARE_SAAS_ZONE_ID: "zone-a", CLOUDFLARE_SHARED_ZONE_ID: "zone-b" };

	test("changes nothing without --apply", async () => {
		const { calls, fetchImpl } = api();
		const lines = [];
		await main(["--to", "router"], { env, fetchImpl, log: (line) => lines.push(line) });
		assert.deepEqual(calls.map(({ method }) => method), ["GET", "GET"], "one listing per zone, no write");
		assert.match(lines.join("\n"), /Dry run: nothing changed/);
	});

	test("with --apply it puts each route back with the same pattern and the new Worker, in each zone", async () => {
		const { calls, fetchImpl } = api();
		await main(["--to", "router", "--apply"], { env, fetchImpl, log: () => {} });
		const puts = calls.filter(({ method }) => method === "PUT");
		assert.equal(puts.length, 6);
		assert.deepEqual(puts[0].body, { pattern: "news.example.com/*", script: "flockstack-router" });
		assert.match(puts[0].url, /\/zones\/zone-a\/workers\/routes\/r1$/);
		assert.equal(puts[0].authorization, "Bearer token");
	});

	test("refuses without a token, a zone or a direction", async () => {
		await assert.rejects(main(["--to", "router"], { env: {}, fetchImpl: api().fetchImpl, log: () => {} }), /No zone/);
		await assert.rejects(main(["--to", "router", "--zone", "z"], { env: {}, fetchImpl: api().fetchImpl, log: () => {} }), /CLOUDFLARE_API_TOKEN/);
		assert.throws(() => parseArgs(["--zone", "z"]), /--to takes/);
		assert.throws(() => parseArgs(["--to", "router", "--only", "mars", "--zone", "z"]), /--only takes/);
	});

	test("a refusal from Cloudflare stops the run with its words", async () => {
		const fetchImpl = async () => Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status: 403 });
		await assert.rejects(main(["--to", "router", "--zone", "z"], { env: { CLOUDFLARE_API_TOKEN: "t" }, fetchImpl, log: () => {} }), /Authentication error \(10000\)/);
	});
});
