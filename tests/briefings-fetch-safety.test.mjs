import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, test } from "node:test";
import { startTestApp } from "./helpers/app.mjs";

// The briefings fetcher's safety rules (docs/BRIEFINGS-SAFETY.md): every way of writing a private address, redirects into a
// network, bodies past the size or time cap, robots.txt on every host a page is read from, the provider's fetch, model servers,
// preview images, the account's own fetch allowance and the Node fetch that checks each address as it connects. No network: every
// fetch is a stub, and the one socket opened is a loopback server that must never be reached.

let app;
let m;
const PUBLIC = async () => ["93.184.216.34"];
const SECRET = "sk-test-abcdefghijklmnop0123SECRET";

before(async () => {
	app = await startTestApp();
	const docdb = await import("../lib/docdb/index.js");
	m = {
		ObjectId: docdb.ObjectId,
		fetching: await import("../lib/briefings/fetch.js"),
		robots: await import("../lib/briefings/robots.js"),
		readable: await import("../lib/briefings/readable.js"),
		providers: await import("../lib/briefings/providers.js"),
		meter: await import("../lib/briefings/meter.js"),
		extract: await import("../lib/briefings/extract.js"),
		discovery: await import("../lib/briefings/discovery/index.js"),
		pacing: await import("../lib/briefings/discovery/pacing.js"),
		nodeFetch: await import("../lib/briefings/node-fetch.js"),
		rules: await import("../lib/briefing-rules.js"),
		aiKeys: await import("../lib/ai-keys.js"),
		webhookUrl: await import("../lib/webhook-url.js"),
	};
});

after(() => app?.stop());

function respond(routes, log = []) {
	return async (input, init = {}) => {
		const url = String(input);
		log.push({ url, method: init.method ?? "GET" });
		const route = routes[url] ?? routes["*"];
		if (!route) return new Response("", { status: 404 });
		return route();
	};
}

// A body that never ends: `chunk` bytes at a time, every `everyMs` (0: as fast as it is read). Counts what was handed out.
function endless({ chunk = 64 * 1024, everyMs = 0 } = {}) {
	const state = { sent: 0, cancelled: false };
	const body = new ReadableStream({
		async pull(controller) {
			if (everyMs) await new Promise((resolve) => setTimeout(resolve, everyMs));
			state.sent += chunk;
			controller.enqueue(new Uint8Array(chunk).fill(97));
		},
		cancel() {
			state.cancelled = true;
		},
	});
	return { body, state };
}

async function withTimeout(object, field, value, run) {
	const before = object[field];
	object[field] = value;
	try {
		return await run();
	} finally {
		object[field] = before;
	}
}

describe("private addresses", () => {
	const WRITTEN = [
		"https://2130706433/",
		"https://0177.0.0.1/",
		"https://0x7f.0.0.1/",
		"https://127.1/",
		"https://0/",
		"https://169.254.169.254/latest/meta-data",
		"https://100.64.0.1/",
		"https://[::1]/",
		"https://[::ffff:127.0.0.1]/",
		"https://[::ffff:a9fe:a9fe]/",
		"https://[::127.0.0.1]/",
		"https://[fe80::1]/",
		"https://[fec0::1]/",
		"https://[fd12:3456::1]/",
		"https://[64:ff9b::a9fe:a9fe]/",
		"https://[64:ff9b:1::a00:1]/",
		"https://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/",
		"https://[2002:7f00:1::]/",
		"https://[100::1]/",
		"https://localhost./",
		"https://admin.localhost/",
		"https://metadata.google.internal/",
		"https://printer.local/",
	];

	test("every way of writing one is refused before any request, for pages, links, provider APIs and model servers", async () => {
		m.robots.clearRobotsCache();
		const log = [];
		const fetcher = m.fetching.createFetcher({ fetchImpl: respond({ "*": () => new Response("<p>ok</p>") }, log), resolveHost: PUBLIC });
		const meter = () => m.meter.createMeter({ budgetUsd: 1, prices: [{ model: "local-model", inputPerMillion: 0.1, outputPerMillion: 0.1 }], calls: [] });
		for (const link of WRITTEN) {
			await assert.rejects(fetcher.get(link), /private network/, link);
			assert.equal((await fetcher.checkLink(link)).state, "broken", link);
			await assert.rejects(fetcher.api(link), /private network/, link);
			assert.match(m.aiKeys.getAiBaseUrlProblem(`${link.replace(/\/$/, "")}/v1`) ?? "", /private network/, link);
			await assert.rejects(
				m.providers.callModel({ step: "write", model: "local-model", system: "S", user: "U", maxTokens: 10, fetchImpl: fetcher.api, meter: meter(), guard: fetcher.assertPublic, key: { keyId: "k", provider: "openai-compatible", baseUrl: `${link.replace(/\/$/, "")}/v1`, secret: SECRET } }),
				/private network/,
				link
			);
		}
		assert.deepEqual(log, [], "nothing was asked");
	});

	test("a name is refused when any address it resolves to is private, however DNS writes it", async () => {
		m.robots.clearRobotsCache();
		const log = [];
		const answers = { "mapped.example.com": ["::ffff:10.0.0.1"], "nat64.example.com": ["64:ff9b::7f00:1"], "teredo.example.com": ["2001:0:4136:e378:8000:63bf:3fff:fdd2"], "cgnat.example.com": ["100.100.100.100"], "link.example.com": ["93.184.216.34", "169.254.10.10"], "ula.example.com": ["fd00::5"] };
		const fetcher = m.fetching.createFetcher({ fetchImpl: respond({ "*": () => new Response("ok") }, log), resolveHost: async (host) => answers[host] ?? ["93.184.216.34"] });
		for (const host of Object.keys(answers)) {
			await assert.rejects(fetcher.get(`https://${host}/story`), /private network/, host);
			await assert.rejects(fetcher.api(`https://${host}/feed.json`), /private network/, host);
		}
		assert.deepEqual(log, []);
	});

	test("a redirect into a network is refused at that hop, written any way, and its target never asked", async () => {
		m.robots.clearRobotsCache();
		const log = [];
		const hops = { "https://news.example.com/a": "https://2130706433/admin", "https://news.example.com/b": "https://[::ffff:7f00:1]/", "https://news.example.com/c": "https://inside.example.com/", "https://news.example.com/d": "http://news.example.com/plain" };
		const fetcher = m.fetching.createFetcher({
			fetchImpl: respond({ ...Object.fromEntries(Object.entries(hops).map(([from, to]) => [from, () => new Response(null, { status: 302, headers: { location: to } })])), "https://news.example.com/robots.txt": () => new Response("", { status: 404 }) }, log),
			resolveHost: async (host) => (host === "inside.example.com" ? ["192.168.0.10"] : ["93.184.216.34"]),
		});
		for (const from of Object.keys(hops)) await assert.rejects(fetcher.get(from), /private network|https/, from);
		assert.ok(log.every(({ url }) => url.startsWith("https://news.example.com/")), JSON.stringify(log));
		assert.equal((await fetcher.checkLink("https://news.example.com/a")).state, "broken");
	});

	test("a key's server or a candidate feed on a private address can't be saved, and is refused again when used", () => {
		for (const baseUrl of ["https://2130706433/v1", "https://[::ffff:a9fe:a9fe]/v1", "https://[64:ff9b:1::1]/v1", "https://[2001::1]/v1", "https://[fec0::1]/feed"]) {
			for (const provider of ["openai-compatible", "candidate-feed"]) {
				assert.match(m.aiKeys.getAiKeyProblem({ name: "x", provider, key: SECRET, baseUrl }) ?? "", /private network/, `${provider} ${baseUrl}`);
			}
			assert.throws(() => m.providers.resolveBaseUrl({ provider: "openai-compatible", baseUrl }, {}), /private network/, baseUrl);
		}
		assert.equal(m.webhookUrl.getWebhookUrlProblem("https://[2606:4700::1111]/hook"), null, "a public IPv6 address is still fine");
	});
});

describe("size and time caps", () => {
	test("a page with no length streamed past 1 MB is cut off and the rest never read", async () => {
		m.robots.clearRobotsCache();
		const { body, state } = endless();
		const fetcher = m.fetching.createFetcher({ fetchImpl: respond({ "https://big.example.com/page": () => new Response(body), "https://big.example.com/robots.txt": () => new Response("", { status: 404 }) }), resolveHost: PUBLIC });
		await assert.rejects(fetcher.get("https://big.example.com/page"), /over 1 MB/);
		assert.ok(state.cancelled, "the body was cancelled");
		assert.ok(state.sent < 1_300_000, `read ${state.sent} bytes`);
	});

	test("a page whose body trickles past the time cap stops at the cap, even when fetchImpl ignores its signal", async () => {
		m.robots.clearRobotsCache();
		const { body, state } = endless({ chunk: 10, everyMs: 20 });
		const fetcher = m.fetching.createFetcher({ fetchImpl: respond({ "https://slow.example.com/page": () => new Response(body), "https://slow.example.com/robots.txt": () => new Response("", { status: 404 }) }), resolveHost: PUBLIC });
		const started = Date.now();
		await withTimeout(m.fetching.FETCH_LIMITS, "timeoutMs", 200, () => assert.rejects(fetcher.get("https://slow.example.com/page"), /took too long/));
		assert.ok(Date.now() - started < 2000, "stopped near the cap");
		assert.ok(state.cancelled);
	});

	test("headers that never come stop at the time cap too", async () => {
		m.robots.clearRobotsCache();
		const fetchImpl = async (url) => (String(url).endsWith("/robots.txt") ? new Response("", { status: 404 }) : new Promise(() => {}));
		const fetcher = m.fetching.createFetcher({ fetchImpl, resolveHost: PUBLIC });
		await withTimeout(m.fetching.FETCH_LIMITS, "timeoutMs", 100, () => assert.rejects(fetcher.get("https://hang.example.com/page"), /took too long/));
	});

	test("a provider API's answer is held to the same caps", async () => {
		const big = endless();
		const fetcher = m.fetching.createFetcher({ fetchImpl: async () => new Response(big.body), resolveHost: PUBLIC });
		await assert.rejects(fetcher.api("https://api.example.com/search", { bytes: 100_000 }), /over 1 MB|over/);
		assert.ok(big.state.sent < 300_000);
		const slow = endless({ chunk: 5, everyMs: 20 });
		const trickle = m.fetching.createFetcher({ fetchImpl: async () => new Response(slow.body), resolveHost: PUBLIC });
		await assert.rejects(trickle.api("https://api.example.com/search", { timeoutMs: 150 }), /took too long/);
	});

	test("a model server's answer over 2 MB, or one still arriving at the timeout, is an error rather than memory", async () => {
		const quiet = () => m.meter.createMeter({ budgetUsd: 1, prices: [{ model: "local-model", inputPerMillion: 0.1, outputPerMillion: 0.1 }], calls: [] });
		const key = { keyId: "k", provider: "openai-compatible", baseUrl: "https://llm.example.com/v1", secret: SECRET };
		const base = { step: "write", model: "local-model", system: "S", user: "U", maxTokens: 10, key, guard: async () => {} };
		const big = endless();
		await assert.rejects(m.providers.callModel({ ...base, meter: quiet(), fetchImpl: async () => new Response(big.body, { status: 200 }) }), /over 2 MB/);
		assert.ok(big.state.sent < 2_400_000);
		const slow = endless({ chunk: 5, everyMs: 20 });
		await withTimeout(m.providers.CALL_LIMITS, "timeoutMs", 150, () => assert.rejects(m.providers.callModel({ ...base, meter: quiet(), fetchImpl: async () => new Response(slow.body, { status: 200 }) }), /took too long/));
		const noisy = endless();
		const error = await m.providers.callModel({ ...base, meter: quiet(), fetchImpl: async () => new Response(noisy.body, { status: 400 }) }).catch((caught) => caught);
		assert.match(error.message, /answered 400/);
		assert.ok(noisy.state.sent < 200_000, "an error body is read only as far as its short line");
	});
});

describe("robots.txt", () => {
	test("is read for the host a redirect lands on, and that host's refusal stops the page", async () => {
		m.robots.clearRobotsCache();
		const log = [];
		const fetcher = m.fetching.createFetcher({
			fetchImpl: respond(
				{
					"https://short.example.com/robots.txt": () => new Response("", { status: 404 }),
					"https://short.example.com/x": () => new Response(null, { status: 301, headers: { location: "https://shy.example.org/story" } }),
					"https://shy.example.org/robots.txt": () => new Response("User-agent: FlockStack-Briefings\nDisallow: /\n"),
				},
				log
			),
			resolveHost: PUBLIC,
		});
		const error = await fetcher.get("https://short.example.com/x").catch((caught) => caught);
		assert.equal(error.robots, true);
		assert.deepEqual(
			log.map(({ url }) => url),
			["https://short.example.com/robots.txt", "https://short.example.com/x", "https://shy.example.org/robots.txt"]
		);
		assert.deepEqual(await fetcher.checkLink("https://short.example.com/x"), { url: "https://short.example.com/x", state: "unsure", reason: "robots.txt asks FlockStack not to open it" });
	});

	test("a file over the cap is read as far as the cap, not taken as allowing everything", async () => {
		m.robots.clearRobotsCache();
		const file = `User-agent: *\nDisallow: /\n${"# padding\n".repeat(20_000)}`;
		const fetcher = m.fetching.createFetcher({ fetchImpl: respond({ "https://long.example.com/robots.txt": () => new Response(file), "*": () => new Response("<p>ok</p>") }), resolveHost: PUBLIC });
		assert.ok(file.length > m.robots.ROBOTS.bytes);
		assert.equal(await fetcher.allowedByRobots("https://long.example.com/story"), false);
	});

	test("a file that stalls counts as unreachable, which disallows the host", async () => {
		m.robots.clearRobotsCache();
		const { body } = endless({ chunk: 4, everyMs: 30 });
		const fetcher = m.fetching.createFetcher({ fetchImpl: respond({ "https://stall.example.com/robots.txt": () => new Response(body) }), resolveHost: PUBLIC });
		await withTimeout(m.fetching.FETCH_LIMITS, "timeoutMs", 150, async () => assert.equal(await fetcher.allowedByRobots("https://stall.example.com/story"), false));
	});

	test("a file that redirects to a host one briefing blocks is unreadable for that briefing only", async () => {
		m.robots.clearRobotsCache();
		const log = [];
		const routes = {
			"https://site.example.com/robots.txt": () => new Response(null, { status: 301, headers: { location: "https://cdn.example.net/robots.txt" } }),
			"https://cdn.example.net/robots.txt": () => new Response("User-agent: *\nAllow: /\n"),
			"https://site.example.com/story": () => new Response("<p>ok</p>"),
		};
		const blocking = m.fetching.createFetcher({ fetchImpl: respond(routes, log), resolveHost: PUBLIC, blockedHosts: ["cdn.example.net"] });
		const open = m.fetching.createFetcher({ fetchImpl: respond(routes, log), resolveHost: PUBLIC });
		assert.equal(await blocking.allowedByRobots("https://site.example.com/story"), false);
		assert.ok(!log.some(({ url }) => url.includes("cdn.example.net")), "the blocked host was never asked");
		assert.equal(await open.allowedByRobots("https://site.example.com/story"), true, "another briefing isn't held to that block");
	});
});

describe("the search provider's fetch", () => {
	function ctxWith({ finalUrl, blocked = () => false, allowed = async () => true }) {
		const asked = [];
		const original = m.discovery.ADAPTERS.tinyfish.fetch;
		m.discovery.ADAPTERS.tinyfish.fetch = async ({ url }) => {
			asked.push(url);
			return { url, finalUrl: finalUrl ?? url, status: 200, text: "Text", links: [] };
		};
		const ctx = {
			run: { accountId: new m.ObjectId(), discoveryNotes: [] },
			work: {},
			clock: () => new Date("2026-10-28T09:00:00Z"),
			canWait: () => true,
			sleep: async () => {},
			briefing: { discovery: { searchKeyId: "k-fetch" } },
			searchKey: async () => ({ provider: "tinyfish", secret: SECRET }),
			fetcher: { api: async () => ({}), get: async () => ({}), isBlocked: blocked, allowedByRobots: allowed },
		};
		return { ctx, asked, restore: () => (m.discovery.ADAPTERS.tinyfish.fetch = original) };
	}

	test("a page it reached through a redirect is held to that host's robots.txt and the briefing's blocked hosts", async () => {
		const robotsAsked = [];
		const shy = ctxWith({ finalUrl: "https://shy.example.org/story", allowed: async (url) => (robotsAsked.push(url), !url.includes("shy.example.org")) });
		try {
			assert.equal(await m.discovery.providerFetcher(shy.ctx)("https://app.example.com/page"), null);
			assert.deepEqual(robotsAsked, ["https://app.example.com/page", "https://shy.example.org/story"]);
		} finally {
			shy.restore();
		}
		const blocked = ctxWith({ finalUrl: "https://blocked.example.org/story", blocked: (url) => url.includes("blocked.example.org") });
		try {
			assert.equal(await m.discovery.providerFetcher(blocked.ctx)("https://app.example.com/page"), null);
		} finally {
			blocked.restore();
		}
		const same = ctxWith({});
		try {
			assert.equal((await m.discovery.providerFetcher(same.ctx)("https://app.example.com/page")).text, "Text");
		} finally {
			same.restore();
		}
	});

	test("is never asked for an address our own fetch may not open", async () => {
		const each = ctxWith({});
		try {
			for (const link of ["http://app.example.com/page", "https://10.0.0.1/page", "https://[::ffff:7f00:1]/", "https://intranet.local/page"]) {
				assert.equal(await m.discovery.providerFetcher(each.ctx)(link), null, link);
			}
			assert.deepEqual(each.asked, []);
		} finally {
			each.restore();
		}
	});
});

describe("preview images", () => {
	const image = (content) => m.readable.readablePage(`<html><head><meta property="og:image" content="${content}"></head><body><p>Text</p></body></html>`, "https://news.example.com/story").image;

	test("an og:image inside a private network, on a port or with a user name is no preview: the owner's browser would load it", () => {
		for (const content of ["https://192.168.1.1/admin.png", "https://[::1]/a.png", "https://localhost/a.png", "https://2130706433/a.png", "https://router.local/a.png", "https://cdn.example.com:8443/a.png", "https://user:pass@cdn.example.com/a.png"]) {
			assert.equal(image(content), null, content);
		}
		assert.equal(image("https://cdn.example.com/a.jpg"), "https://cdn.example.com/a.jpg");
	});

	test("an og:image on a host the briefing blocks is not recorded", async () => {
		const page = (src) => `<html><head><meta property="og:image" content="${src}"></head><body><article><p>${"Acme opened a battery plant in Ohio this week, with 500 jobs. ".repeat(4)}</p></article></body></html>`;
		const run = (src) =>
			m.extract.extractOneLiner({
				story: { key: "s1", title: "Acme opens a plant", sources: [{ url: "https://news.example.com/story", sourceKind: "reporting" }] },
				n: 1,
				fetcher: { get: async (url) => ({ url, text: page(src) }), isBlocked: (url) => new URL(url).hostname.endsWith("tracker.example.net") },
				key: { provider: "openai" },
				model: "gpt-4o-mini",
				models: { text: async () => ({ json: { what: "Acme opened a battery plant in Ohio." } }) },
				resolved: {},
			});
		assert.equal((await run("https://img.tracker.example.net/pixel.gif")).previewImage, null);
		assert.equal((await run("https://cdn.example.com/plant.jpg")).previewImage, "https://cdn.example.com/plant.jpg");
	});
});

describe("the account's fetch allowance", () => {
	const NOW = new Date("2026-10-28T09:30:00Z");

	test("is a constant shared by every briefing of the account, apart from other accounts", async () => {
		assert.deepEqual(m.rules.ACCOUNT_FETCH_LIMITS, { hour: 600, day: 3000 });
		const accountId = new m.ObjectId();
		const limits = { hour: 25, day: 100 };
		const reserve = (id = accountId) => (n) => m.pacing.reserveFetches({ accountId: id, n, limits, now: NOW });
		const routes = respond({ "*": () => new Response("<p>ok</p>") });
		m.robots.clearRobotsCache();
		const first = m.fetching.createFetcher({ fetchImpl: routes, resolveHost: PUBLIC, reserve: reserve() });
		const second = m.fetching.createFetcher({ fetchImpl: routes, resolveHost: PUBLIC, reserve: reserve() });
		// The first briefing's robots.txt and 12 pages take two chunks of 10; the second briefing gets the 5 that are left of 25.
		for (let index = 0; index < 12; index++) await first.get(`https://a.example.com/${index}`);
		for (let index = 0; index < 4; index++) await second.get(`https://b.example.com/${index}`);
		await assert.rejects(second.get("https://b.example.com/4"), /the account reached its 25 fetches an hour/);
		await assert.rejects(first.get("https://a.example.com/12").then(() => first.get("https://a.example.com/13")).then(() => first.get("https://a.example.com/14")).then(() => first.get("https://a.example.com/15")).then(() => first.get("https://a.example.com/16")).then(() => first.get("https://a.example.com/17")).then(() => first.get("https://a.example.com/18")).then(() => first.get("https://a.example.com/19")), /the account reached its 25 fetches an hour/, "the first uses up its own chunk, then stops too");
		assert.equal((await second.checkLink("https://b.example.com/11")).state, "unsure", "a link past the allowance is unsure, not broken");
		const other = m.fetching.createFetcher({ fetchImpl: routes, resolveHost: PUBLIC, reserve: reserve(new m.ObjectId()) });
		await other.get("https://c.example.com/1");
		const later = m.fetching.createFetcher({ fetchImpl: routes, resolveHost: PUBLIC, reserve: (n) => m.pacing.reserveFetches({ accountId, n, limits, now: new Date("2026-10-28T10:05:00Z") }) });
		await later.get("https://a.example.com/next-hour");
	});

	test("a reservation takes what fits in every window and gives the rest back", async () => {
		const accountId = new m.ObjectId();
		const limits = { hour: 600, day: 15 };
		assert.deepEqual(await m.pacing.reserveFetches({ accountId, n: 10, limits, now: NOW }), { granted: 10, scope: "hour", limit: 600 });
		assert.deepEqual(await m.pacing.reserveFetches({ accountId, n: 10, limits, now: NOW }), { granted: 5, scope: "day", limit: 15 });
		assert.deepEqual(await m.pacing.reserveFetches({ accountId, n: 10, limits, now: NOW }), { granted: 0, scope: "day", limit: 15 });
		const { default: DiscoveryUsage } = await import("../models/DiscoveryUsage.js");
		const rows = await DiscoveryUsage.find({ accountId, provider: "fetcher" }).lean();
		assert.deepEqual(Object.fromEntries(rows.map(({ window, count }) => [window, count])), { hour: 15, day: 15 });
	});

	test("a run's engine reserves from it", async () => {
		const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../lib/briefings/index.js", import.meta.url), "utf8"));
		assert.equal((source.match(/reserve: \(n\) => reserveFetches\(\{ accountId: run\.accountId/g) ?? []).length, 2, "both of a run's fetchers");
	});
});

describe("the Node fetch", () => {
	test("checks every address as the connection opens, so a name can't answer the check one way and the connection another", async () => {
		let connections = 0;
		const server = http.createServer((request, response) => response.end("inside"));
		server.on("connection", () => (connections += 1));
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address();
		try {
			// A rebinding name: public when the fetcher asked, loopback when the connection looks it up.
			const lookup = (hostname, options, callback) => callback(null, [{ address: "127.0.0.1", family: 4 }]);
			const fetchImpl = await m.nodeFetch.createPinnedFetch({ lookup });
			await assert.rejects(fetchImpl(`http://rebind.example.com:${port}/`), /private network/);
			await assert.rejects(fetchImpl(`http://127.0.0.1:${port}/`), /private network/);
			await assert.rejects(fetchImpl(`http://[::ffff:7f00:1]:${port}/`), /private network/);
			assert.equal(connections, 0, "nothing reached the server");
		} finally {
			server.close();
		}
	});

	test("its lookup hands back only checked public addresses, and refuses a name with any private one", async () => {
		const lookup = (answers) => (hostname, options, callback) => callback(null, answers);
		const ask = (answers, options = {}) => new Promise((resolve) => m.nodeFetch.publicLookup(lookup(answers))("news.example.com", options, (...args) => resolve(args)));
		assert.deepEqual(await ask([{ address: "93.184.216.34", family: 4 }]), [null, "93.184.216.34", 4]);
		assert.deepEqual(await ask([{ address: "93.184.216.34", family: 4 }], { all: true }), [null, [{ address: "93.184.216.34", family: 4 }]]);
		for (const answers of [[{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }], [{ address: "::ffff:169.254.169.254", family: 6 }], [{ address: "fe80::1", family: 6 }], []]) {
			const [error] = await ask(answers);
			assert.match(error?.message ?? "", /private network/, JSON.stringify(answers));
		}
	});

	test("is the engine's default outside a Worker", async () => {
		const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../lib/briefings/index.js", import.meta.url), "utf8"));
		assert.match(source, /fetchImpl \?\?= globalThis\.navigator\?\.userAgent === "Cloudflare-Workers" \? globalThis\.fetch : await \(await import\("\.\/node-fetch\.js"\)\)\.createPinnedFetch\(\);/);
		const route = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../app/api/cron/hourly/route.js", import.meta.url), "utf8"));
		assert.doesNotMatch(route.slice(route.indexOf("runBriefingsInCron"), route.indexOf("runBriefingsInCron") + 800), /fetchImpl:/, "the self-hosted cron leaves the engine its own fetch");
	});
});
