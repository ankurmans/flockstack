import assert from "node:assert/strict";
import { describe, test } from "node:test";

// The briefings engine's parts on their own (docs/BRIEFINGS-DESIGN.md): addresses, robots.txt, the fetcher's limits, page text,
// prices and the cost cap, the provider adapters, the draft's citations and the code checks. No network: every fetch is a stub.

const urls = await import("../lib/briefings/urls.js");
const robots = await import("../lib/briefings/robots.js");
const fetching = await import("../lib/briefings/fetch.js");
const readable = await import("../lib/briefings/readable.js");
const prices = await import("../lib/briefings/prices.js");
const meter = await import("../lib/briefings/meter.js");
const providers = await import("../lib/briefings/providers.js");
const text = await import("../lib/briefings/text.js");
const write = await import("../lib/briefings/write.js");
const check = await import("../lib/briefings/check.js");
const dedupe = await import("../lib/briefings/dedupe.js");
const group = await import("../lib/briefings/group.js");
const labels = await import("../lib/briefings/labels.js");
const rank = await import("../lib/briefings/rank.js");
const triage = await import("../lib/briefings/triage.js");
const stages = await import("../lib/briefings/stages.js");
const extractModule = await import("../lib/briefings/extract.js");
const { AI_PROVIDER_ENDPOINTS } = await import("../lib/ai-keys.js");

const SECRET = "sk-test-abcdefghijklmnop0123SECRET";

function respond(routes, log = []) {
	return async (input, init = {}) => {
		const url = String(input);
		log.push({ url, method: init.method ?? "GET", headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
		const route = routes[url] ?? routes["*"];
		if (!route) return new Response("Not found", { status: 404 });
		const answer = typeof route === "function" ? await route(log.at(-1)) : route;
		return answer instanceof Response ? answer : Response.json(answer);
	};
}

describe("addresses", () => {
	test("a canonical address has a lower-case host and no fragment, tracking parameters or AMP path", () => {
		assert.equal(urls.canonicalUrl("https://News.Example.COM/a/story?utm_source=x&utm_medium=y&id=7&fbclid=1&gclid=2&ref=hn#comments"), "https://news.example.com/a/story?id=7");
		assert.equal(urls.canonicalUrl("https://news.example.com/amp/a/story"), "https://news.example.com/a/story");
		assert.equal(urls.canonicalUrl("https://amp.example.com/story.amp.html"), "https://example.com/story.html");
		assert.equal(urls.canonicalUrl("https://news.example.com/story?amp=1"), "https://news.example.com/story");
		assert.equal(urls.canonicalUrl("mailto:someone@example.com"), null);
		assert.equal(urls.canonicalUrl("not a url"), null);
	});

	test("discovery's finds become items keyed by the SHA-256 of their canonical address, and dedupe keeps only the new", async () => {
		const item = await dedupe.toItem({ url: "https://news.example.com/a?utm_source=x", title: "  A   story ", snippet: "First.", publishedAt: "2026-10-28T08:00:00Z", publisher: "News", foundBy: "query:a" });
		assert.equal(item.url, "https://news.example.com/a");
		assert.equal(item.title, "A story");
		assert.equal(item.urlHash, await urls.sha256Hex("https://news.example.com/a"));
		assert.equal(item.urlHash.length, 64);
		assert.equal(await dedupe.toItem({ url: "ftp://example.com/x" }), null);

		const old = await dedupe.toItem({ url: "https://news.example.com/old", publishedAt: "2026-10-01T00:00:00Z" });
		const undated = await dedupe.toItem({ url: "https://news.example.com/undated" });
		const known = await dedupe.toItem({ url: "https://news.example.com/known" });
		const asked = [];
		const fresh = await dedupe.dedupeItems({
			items: [item, { ...item }, old, undated, known],
			since: "2026-10-27T00:00:00Z",
			seen: async (hashes) => {
				asked.push(...hashes);
				return new Set([known.urlHash]);
			},
		});
		assert.deepEqual(
			fresh.map(({ url }) => url),
			["https://news.example.com/a", "https://news.example.com/undated"]
		);
		assert.equal(asked.length, 4, "one lookup per address");
	});
});

describe("robots.txt", () => {
	const file = ["User-agent: *", "Disallow: /", "", "User-agent: Googlebot", "User-agent: FlockStack", "Disallow: /private", "Allow: /private/press", "Disallow: /*.pdf$", "Disallow:"].join("\n");

	test("FlockStack's own group wins over the one for everyone, and the longest rule wins", () => {
		const rules = robots.parseRobots(file);
		assert.equal(robots.isAllowed(rules, "/news/story"), true);
		assert.equal(robots.isAllowed(rules, "/private/memo"), false);
		assert.equal(robots.isAllowed(rules, "/private/press/release"), true);
		assert.equal(robots.isAllowed(rules, "/files/report.pdf"), false);
		assert.equal(robots.isAllowed(rules, "/files/report.pdf?x=1"), true);
		const everyone = robots.parseRobots("User-agent: *\nDisallow: /drafts/\n");
		assert.equal(robots.isAllowed(everyone, "/drafts/1"), false);
		assert.equal(robots.isAllowed(everyone, "/posts/1"), true);
	});

	test("a missing file allows everything, a server error disallows the host for an hour, and an answer is kept a day", async () => {
		robots.clearRobotsCache();
		let loads = 0;
		const missing = async () => ((loads += 1), { status: 404, text: "" });
		assert.deepEqual(await robots.getRobotsRules("https://a.example.com/x", missing, 0), []);
		await robots.getRobotsRules("https://a.example.com/y", missing, 23 * 60 * 60_000);
		assert.equal(loads, 1);
		await robots.getRobotsRules("https://a.example.com/y", missing, 25 * 60 * 60_000);
		assert.equal(loads, 2);
		const failing = async () => ({ status: 503, text: "" });
		assert.equal(robots.isAllowed(await robots.getRobotsRules("https://b.example.com/", failing, 0), "/anything"), false);
		const down = async () => {
			throw new Error("unreachable");
		};
		assert.equal(robots.isAllowed(await robots.getRobotsRules("https://c.example.com/", down, 0), "/"), false);
		let again = 0;
		await robots.getRobotsRules("https://b.example.com/", async () => ((again += 1), { status: 200, text: "" }), 61 * 60_000);
		assert.equal(again, 1, "a failure is tried again after an hour");
	});
});

describe("the fetcher", () => {
	const PUBLIC = async () => ["93.184.216.34"];

	test("keeps the feed fetcher's limits and names itself on every request", async () => {
		const { FEED_LIMITS } = await import("../lib/feed-fetch.js");
		assert.equal(fetching.FETCH_LIMITS.bytes, FEED_LIMITS.bytes);
		assert.equal(fetching.FETCH_LIMITS.timeoutMs, FEED_LIMITS.timeoutMs);
		assert.equal(fetching.FETCH_LIMITS.redirects, FEED_LIMITS.redirects);
		assert.deepEqual([fetching.FETCH_LIMITS.perHost, fetching.FETCH_LIMITS.perRun], [2, 300]);
		robots.clearRobotsCache();
		const log = [];
		const fetcher = fetching.createFetcher({ fetchImpl: respond({ "https://news.example.com/a": new Response("<p>ok</p>") }, log), resolveHost: PUBLIC });
		await fetcher.get("https://news.example.com/a");
		assert.ok(log.every(({ headers }) => headers["user-agent"] === "FlockStack-Briefings/1.0 (+https://flockstack.io/docs/briefings-bot)"));
		assert.ok(log.every(({ headers }) => !("cookie" in headers)));
	});

	test("refuses private and plain http addresses, names that resolve inside a network, and checks every redirect", async () => {
		robots.clearRobotsCache();
		const log = [];
		const resolveHost = async (host) => ({ "inside.example.com": ["10.1.2.3"], "mixed.example.com": ["93.184.216.34", "fd00::1"], "nowhere.example.com": [] })[host] ?? ["93.184.216.34"];
		const fetcher = fetching.createFetcher({
			fetchImpl: respond({ "https://news.example.com/moved": new Response(null, { status: 301, headers: { location: "https://inside.example.com/admin" } }), "https://news.example.com/meta": new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest/meta-data" } }) }, log),
			resolveHost,
		});
		await assert.rejects(fetcher.get("https://10.0.0.1/page"), /private network/);
		await assert.rejects(fetcher.get("https://localhost/page"), /private network/);
		await assert.rejects(fetcher.get("http://news.example.com/page"), /https/);
		await assert.rejects(fetcher.get("https://inside.example.com/page"), /the name points inside a private network/);
		await assert.rejects(fetcher.get("https://mixed.example.com/page"), /private network/, "every address must be public, not just the first");
		await assert.rejects(fetcher.get("https://nowhere.example.com/page"), /doesn't resolve/);
		assert.equal(log.length, 0);
		await assert.rejects(fetcher.get("https://news.example.com/moved"), /the name points inside a private network/);
		await assert.rejects(fetcher.get("https://news.example.com/meta"), /redirects to an address FlockStack can't read: That address is inside a private network/);
		assert.deepEqual(
			log.map(({ url }) => url),
			["https://news.example.com/robots.txt", "https://news.example.com/moved", "https://news.example.com/meta"]
		);
	});

	test("a 401, 403 or 429 is final, and a blocked host or a robots.txt refusal is refused before the request", async () => {
		robots.clearRobotsCache();
		const log = [];
		const fetcher = fetching.createFetcher({
			fetchImpl: respond({ "https://paywall.example.com/story": new Response("no", { status: 403 }), "https://busy.example.com/story": new Response("later", { status: 429 }), "https://shy.example.com/robots.txt": new Response("User-agent: FlockStack-Briefings\nDisallow: /\n") }, log),
			resolveHost: PUBLIC,
			blockedHosts: ["blocked.example.com"],
		});
		for (const url of ["https://paywall.example.com/story", "https://busy.example.com/story"]) {
			const error = await fetcher.get(url).catch((caught) => caught);
			assert.equal(error.final, true);
			assert.match(error.message, /answered (403|429)/);
		}
		assert.equal(log.filter(({ url }) => url.endsWith("/story")).length, 2, "each asked once");
		await assert.rejects(fetcher.get("https://www.blocked.example.com/x"), /blocks this site/);
		const robotsError = await fetcher.get("https://shy.example.com/story").catch((caught) => caught);
		assert.equal(robotsError.robots, true);
		assert.ok(!log.some(({ url }) => url.includes("blocked.example.com") || url === "https://shy.example.com/story"));
		assert.equal(await fetcher.allowedByRobots("https://shy.example.com/other"), false);
	});

	test("asks one host for two pages at a time at most, stops at the run's cap and cuts a page over 1 MB", async () => {
		robots.clearRobotsCache();
		let active = 0;
		let most = 0;
		const fetchImpl = async (input) => {
			const url = String(input);
			if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
			active += 1;
			most = Math.max(most, active);
			await new Promise((resolve) => setTimeout(resolve, 5));
			active -= 1;
			if (url.endsWith("/big")) return new Response("x".repeat(1_000_001));
			return new Response("<p>ok</p>");
		};
		const fetcher = fetching.createFetcher({ fetchImpl, resolveHost: PUBLIC, used: 290 });
		await Promise.all(Array.from({ length: 6 }, (_, index) => fetcher.get(`https://one.example.com/${index}`)));
		assert.equal(most, 2);
		await assert.rejects(fetcher.get("https://one.example.com/big"), /over 1 MB/);
		assert.equal(fetcher.count, 298, "290 from earlier ticks, robots.txt once, six pages and the big one");
		await fetcher.get("https://one.example.com/7");
		await fetcher.get("https://one.example.com/8");
		await assert.rejects(fetcher.get("https://one.example.com/9"), /reached its 300 fetches/);
	});

	test("in a Worker, a name is resolved over DNS over HTTPS", async () => {
		const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
		Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Cloudflare-Workers" }, configurable: true });
		const log = [];
		try {
			const resolve = fetching.createResolver({
				fetchImpl: async (url, init) => {
					log.push({ url: String(url), accept: init.headers.accept });
					return Response.json({ Status: 0, Answer: String(url).includes("type=AAAA") ? [{ type: 28, data: "2606:2800:220:1::1" }] : [{ type: 5, data: "cdn.example.net." }, { type: 1, data: "93.184.216.34" }] });
				},
			});
			assert.deepEqual(await resolve("news.example.com"), ["93.184.216.34", "2606:2800:220:1::1"]);
		} finally {
			if (original) Object.defineProperty(globalThis, "navigator", original);
			else delete globalThis.navigator;
		}
		assert.deepEqual(
			log.map(({ url, accept }) => [url, accept]),
			[
				["https://cloudflare-dns.com/dns-query?name=news.example.com&type=A", "application/dns-json"],
				["https://cloudflare-dns.com/dns-query?name=news.example.com&type=AAAA", "application/dns-json"],
			]
		);
	});
});

describe("page text", () => {
	test("is the article's text without menus, scripts or footers, with its links", () => {
		const page = readable.readablePage(
			`<html><head><title>Fallback</title><meta property="og:title" content="The &amp; title"><link rel="canonical" href="/canonical"></head>
			<body><nav>Menu</nav><script>alert(1)</script><article><h2>Heading</h2><p>First &quot;line&quot;.</p><p>Second <a href="/next">next</a> <a href="mailto:a@example.com">mail</a>.</p><aside>Ad</aside></article><footer>Footer</footer></body></html>`,
			"https://news.example.com/story"
		);
		assert.equal(page.title, "The & title");
		assert.equal(page.text, 'Heading\nFirst "line".\nSecond next mail .');
		assert.equal(page.canonical, "https://news.example.com/canonical");
		assert.deepEqual(page.links, [{ url: "https://news.example.com/next", text: "next" }]);
		assert.equal(readable.readablePage(`<p>${"word ".repeat(10_000)}</p>`, "https://example.com/").text.length, readable.MAX_READABLE_CHARS);
	});
});

describe("prices and the cost cap", () => {
	test("the briefing's own price wins over the table, and a model in neither has none", () => {
		assert.deepEqual(prices.findPrice({ provider: "typesafe", model: "jev-latest" }), { inputPerMillion: 0.042, outputPerMillion: 0, from: "table", verified: true });
		assert.equal(prices.findPrice({ provider: "openai", model: "gpt-4o-mini" }).verified, false, "every list price but Jev's is unverified");
		assert.deepEqual(prices.findPrice({ provider: "openai", model: "gpt-4o-mini", prices: [{ model: "gpt-4o-mini", inputPerMillion: 1, outputPerMillion: 2 }] }), { inputPerMillion: 1, outputPerMillion: 2, from: "briefing", verified: false });
		assert.equal(prices.findPrice({ provider: "openai", model: "gpt-unknown" }), null);
		assert.equal(prices.PRICES_AS_OF, "2026-10");
		assert.ok(Object.keys(prices.PRICE_TABLE).every((provider) => ["openai", "anthropic", "gemini", "openrouter", "groq", "together", "deepinfra", "fireworks", "mistral", "deepseek", "cloudflare", "typesafe"].includes(provider)));
	});

	test("a call is estimated from its input and max_tokens and refused past the budget; the real cost is recorded after", () => {
		const calls = [{ step: "triage", costUsd: 0.2 }];
		const cap = meter.createMeter({ budgetUsd: 0.25, prices: [], calls });
		// 40,000 characters is 10,000 tokens: 10,000 x 0.15 + 1,000 x 0.6 per million = $0.0021.
		assert.equal(cap.admit({ step: "write", provider: "openai", model: "gpt-4o-mini", inputChars: 40_000, maxTokens: 1000 }), 0.0021);
		assert.throws(() => cap.admit({ step: "write", provider: "openai", model: "gpt-4.1-mini", inputChars: 400_000, maxTokens: 8000 }), meter.BudgetStop);
		assert.throws(() => cap.admit({ step: "write", provider: "openai", model: "gpt-unknown", inputChars: 1, maxTokens: 1 }), meter.UnknownPrice);
		assert.deepEqual(cap.record({ step: "extract", provider: "openai", model: "gpt-4o-mini", usage: { inputTokens: 2000, outputTokens: 500 } }), {
			step: "extract",
			provider: "openai",
			model: "gpt-4o-mini",
			inputTokens: 2000,
			outputTokens: 500,
			costUsd: 0.0006,
			costFrom: "price_table",
		});
		assert.equal(cap.record({ step: "write", provider: "openrouter", model: "qwen/qwen3-30b-a3b", usage: { inputTokens: 10, outputTokens: 10, costUsd: 0.00042 } }).costFrom, "provider");
		assert.equal(cap.spent(), 0.20102);
	});
});

describe("providers", () => {
	const openai = { keyId: "k1", provider: "openai", baseUrl: "https://api.openai.com/v1", secret: SECRET };
	const call = (overrides) => ({ step: "extract", model: "gpt-4o-mini", system: "S", user: "U", maxTokens: 100, meter: meter.createMeter({ budgetUsd: 1, prices: [], calls: [] }), endpoints: AI_PROVIDER_ENDPOINTS, ...overrides });

	test("OpenAI-compatible: one Chat Completions call with the key in its header and its usage read back", async () => {
		const log = [];
		const fetchImpl = respond({ "https://api.openai.com/v1/chat/completions": { choices: [{ message: { content: '```json\n{"ok": true}\n```' } }], usage: { prompt_tokens: 12, completion_tokens: 3 } } }, log);
		const result = await providers.callModel(call({ key: openai, json: true, fetchImpl }));
		assert.deepEqual(result.json, { ok: true });
		assert.equal(result.call.inputTokens, 12);
		assert.equal(log[0].headers.authorization, `Bearer ${SECRET}`);
		assert.deepEqual(log[0].body.response_format, { type: "json_object" });
		assert.deepEqual(log[0].body.messages, [
			{ role: "system", content: "S" },
			{ role: "user", content: "U" },
		]);
		assert.equal(log[0].body.usage, undefined);
	});

	test("OpenRouter is asked for its cost and its figure is used as is; Cloudflare gets the user's account in its address", async () => {
		const log = [];
		const fetchImpl = respond({ "*": { choices: [{ message: { content: "Hi" } }], usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.0009 } } }, log);
		const routed = await providers.callModel(call({ key: { keyId: "k2", provider: "openrouter", secret: SECRET }, model: "qwen/qwen3-30b-a3b", fetchImpl }));
		assert.equal(log[0].url, "https://openrouter.ai/api/v1/chat/completions");
		assert.deepEqual(log[0].body.usage, { include: true });
		assert.deepEqual([routed.call.costUsd, routed.call.costFrom], [0.0009, "provider"]);
		const account = "0123456789abcdef0123456789abcdef";
		const cloudflare = await providers.callModel(call({ key: { keyId: "k3", provider: "cloudflare", accountRef: account, secret: SECRET }, model: "@cf/qwen/qwen3-30b-a3b-fp8", fetchImpl }));
		assert.equal(log[1].url, `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1/chat/completions`);
		assert.equal(cloudflare.call.costFrom, "price_table", "only OpenRouter's own figure counts as the provider's");
		await assert.rejects(providers.callModel(call({ key: { keyId: "k4", provider: "cloudflare", secret: SECRET }, model: "@cf/qwen/qwen3-30b-a3b-fp8", fetchImpl })), /account ID/);
		await assert.rejects(providers.callModel(call({ key: { keyId: "k5", provider: "openai-compatible", baseUrl: "https://192.168.1.10/v1", secret: SECRET }, model: "gpt-4o-mini", fetchImpl })), /private network/);
		assert.equal(log.length, 2);
	});

	test("Anthropic Messages, for a user's own Anthropic key", async () => {
		const log = [];
		const fetchImpl = respond({ "https://api.anthropic.com/v1/messages": { content: [{ type: "text", text: "Hello" }], usage: { input_tokens: 20, output_tokens: 4 } } }, log);
		const result = await providers.callModel(call({ key: { keyId: "k6", provider: "anthropic", baseUrl: "https://api.anthropic.com/v1", secret: SECRET }, model: "claude-haiku-4-5", fetchImpl }));
		assert.equal(result.text, "Hello");
		assert.equal(log[0].headers["x-api-key"], SECRET);
		assert.equal(log[0].headers["anthropic-version"], "2023-06-01");
		assert.equal(log[0].headers.authorization, undefined);
		assert.equal(log[0].body.system, "S");
		assert.deepEqual([result.call.inputTokens, result.call.outputTokens, result.call.costUsd], [20, 4, 0.00004]);
	});

	test("TypeSafe: one System One request, priced per input token, and never asked to write", async () => {
		const log = [];
		const fetchImpl = respond({ "https://api.typesafe.ai/v1/systemone": { model: "jev-1.13.0", answers: { s1: { type: "score", score: 3 } }, usage: { input_tokens: 1000, output_tokens: 9 } } }, log);
		const key = { keyId: "k7", provider: "typesafe", baseUrl: "https://api.typesafe.ai/v1", secret: SECRET };
		const questions = { s1: { type: "score", instructions: "How much?", criteria: ["a", "b"] } };
		const result = await providers.callTypeSafe({ key, model: "jev-latest", step: "triage", state: { stories: {} }, questions, fetchImpl, meter: meter.createMeter({ budgetUsd: 1, prices: [], calls: [] }), endpoints: AI_PROVIDER_ENDPOINTS });
		assert.deepEqual(log[0].body, { model: "jev-latest", state: { stories: {} }, questions });
		assert.equal(log[0].headers.authorization, `Bearer ${SECRET}`);
		assert.equal(result.answers.s1.score, 3);
		assert.equal(result.call.costUsd, 0.000042);
		await assert.rejects(providers.callModel(call({ key, model: "jev-latest", fetchImpl })), /can score and check, not write/);
	});

	test("a busy provider is tried once more; an error never carries the key", async () => {
		let attempts = 0;
		const fetchImpl = async () => {
			attempts += 1;
			if (attempts === 1) return new Response("busy", { status: 429, headers: { "retry-after": "0" } });
			return Response.json({ choices: [{ message: { content: "ok" } }], usage: {} });
		};
		assert.equal((await providers.callModel(call({ key: openai, fetchImpl }))).text, "ok");
		assert.equal(attempts, 2);

		attempts = 0;
		const failing = async () => {
			attempts += 1;
			return Response.json({ error: { message: `Server melted while holding ${SECRET}` } }, { status: attempts === 1 ? 529 : 500, headers: { "retry-after": "0" } });
		};
		const error = await providers.callModel(call({ key: openai, fetchImpl: failing })).catch((caught) => caught);
		assert.equal(attempts, 2);
		assert.ok(error instanceof providers.ProviderError);
		assert.equal(error.message, "openai answered 500: Server melted while holding [key]");
		assert.ok(!JSON.stringify({ message: error.message, stack: error.stack, ...error }).includes(SECRET));
		assert.equal(providers.scrubSecret("Authorization: Bearer abcdefghijkl and sk_live_1234567890", ""), "Authorization: Bearer [key] and [key]");
	});

	test("JSON answers are read through code fences and thinking", () => {
		assert.deepEqual(providers.parseJsonAnswer('<think>hmm</think>Here: {"a": 1}'), { a: 1 });
		assert.equal(providers.parseJsonAnswer("no json"), null);
	});
});

describe("drafts and checks", () => {
	const records = [
		{ n: 1, title: "Acme", url: "https://news.example.com/acme", label: "news.example.com", pageNumbers: ["40", "250"], quotes: [{ text: "We build batteries" }], readOriginal: true },
		{ n: 2, title: "Bikes", url: "https://city.example.org/bikes", label: "city.example.org", pageNumbers: ["12"], quotes: [], readOriginal: true },
	];

	test("numbers compare in one form", () => {
		assert.deepEqual(text.numbersIn("$1,234.50, 7 to 2, 12.0 miles, version 3.5.1"), ["1234.5", "7", "2", "12", "3.5.1"]);
	});

	test("the subject and preview come off the top, and citations become links named after each site", () => {
		const draft = write.parseDraft("Subject: Big day\nPreview: Two stories\n\n## Acme\n\nAcme raised $40 million [1].\n\nBoth matter [1, 2]. A stray [9].");
		assert.deepEqual([draft.subject, draft.previewText], ["Big day", "Two stories"]);
		assert.deepEqual(
			write.draftParagraphs(draft.markdown).map(({ cites }) => cites),
			[[1], [1, 2, 9]]
		);
		assert.equal(
			write.linkCitations(draft.markdown, records),
			"## Acme\n\nAcme raised $40 million ([news.example.com](https://news.example.com/acme)).\n\nBoth matter ([news.example.com](https://news.example.com/acme)) ([city.example.org](https://city.example.org/bikes)). A stray ."
		);
	});

	test("code checks: uncited paragraphs, long quotes and links a site won't confirm", async () => {
		const quote = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone twentytwo twentythree twentyfour twentyfive twentysix";
		const draft = { subject: "Acme", previewText: "", markdown: `## Acme\n\nAcme said "${quote}" [1].\n\nThe city has 12 miles of lanes [2].\n\nNobody cited this.` };
		const linkedMarkdown = write.linkCitations(draft.markdown, records);
		const fetcher = { checkLink: async (url) => (url.includes("city") ? { url, state: "unsure", reason: "answered 403" } : { url, state: "ok" }) };
		const checks = await check.codeChecks({ draft, linkedMarkdown, records, fetcher, resolved: {} });
		const byId = Object.fromEntries(checks.map((entry) => [entry.id, entry]));
		assert.equal(byId.citations.status, "warning");
		assert.equal(byId.citations.message, "1 paragraph cite no source");
		assert.equal(byId.quotes.status, "blocker");
		assert.equal(byId.links.status, "warning");
		assert.match(byId.links.message, /city\.example\.org\/bikes \(answered 403\)/);
		assert.equal(byId.numbers.status, "pass");
		assert.equal(byId.originals.status, "pass");
		assert.equal(byId.length.status, "warning");
	});
});

describe("clustering and source labels", () => {
	const items = [
		{ title: "Acme raises $40 million for battery plant", url: "https://a.example.com/1", urlHash: "a", foundBy: ["gdelt"], publisher: "A" },
		{ title: "Acme announces $40 million for battery plant", url: "https://www.prnewswire.com/news-releases/acme.html", urlHash: "b", foundBy: ["hn"], publisher: "" },
		{ title: "Acme raises $40 million for its battery plant", url: "https://trusted.example.org/acme", urlHash: "t", foundBy: ["gdelt", "outlet-feeds"], publisher: "T" },
		{ title: "City approves bike lanes", url: "https://c.example.com/1", urlHash: "c", foundBy: ["gdelt"], publisher: "C" },
		{ title: "Zinc Corp files its annual report", url: "https://www.sec.gov/Archives/edgar/data/1/zinc.htm", urlHash: "z", foundBy: ["gdelt"], publisher: "" },
	];

	test("sources are labelled from their address where it is plain", () => {
		const { labelSource } = labels;
		assert.equal(labelSource("https://www.globenewswire.com/news-release/x"), "press_release");
		assert.equal(labelSource("https://www.businesswire.com/news/home/x"), "press_release");
		assert.equal(labelSource("https://www.sec.gov/Archives/edgar/data/1/x.htm"), "filing");
		assert.equal(labelSource("https://www.ftc.gov/news-events/x"), "regulator");
		assert.equal(labelSource("https://www.gov.uk/government/news/x"), "regulator");
		assert.equal(labelSource("https://newsroom.acme.example/acme-raises"), "company");
		assert.equal(labelSource("https://acme.example/press-releases/series-b"), "company");
		assert.equal(labelSource("https://news.ycombinator.com/item?id=1"), "community");
		assert.equal(labelSource("https://news.example.com/acme"), null, "left to the extract model");
	});

	test("one story per event, its primary source independent reporting (a trusted outlet first) over the press release", () => {
		const stories = group.clusterItems(items, null, { trustedOutlets: ["trusted.example.org"] });
		assert.equal(stories.length, 3);
		assert.deepEqual(
			stories[0].sources.map(({ urlHash, sourceKind }) => [urlHash, sourceKind]),
			[
				["t", null],
				["a", null],
				["b", "press_release"],
			]
		);
		assert.equal(stories[0].url, "https://trusted.example.org/acme");
		assert.deepEqual(stories[0].foundBy, ["gdelt", "hn", "outlet-feeds"]);
		assert.equal(stories[2].sourceKind, "filing");
		assert.equal(labels.originLabel(stories[0].sources, "Acme"), null);
		assert.equal(labels.originLabel([{ sourceKind: "press_release" }], "Acme Corp"), "Announced by Acme Corp");
		assert.equal(labels.originLabel([{ sourceKind: "press_release" }, { sourceKind: "company" }], ""), "Press release");
		assert.equal(labels.originLabel(stories[2].sources, ""), "Filing");
	});

	test("with embeddings, the similarity threshold decides", async () => {
		const ai = { run: async (model, { text: list }, options) => ({ model, options, data: list.map((value) => (value.startsWith("City") ? [0, 1] : value.includes("raises $40 million for battery") ? [1, 0] : [0.8, 0.6])) }) };
		const vectors = await group.embedTexts(ai, items.map(group.embeddingText));
		assert.ok(rank.cosine(vectors[0], vectors[1]) < group.SIMILARITY);
		assert.equal(group.clusterItems(items, vectors).length, 3);
	});

	test("a press-release-only story is labelled in the issue by code: under a full story's heading, at a brief item's start", () => {
		const markdown = "## Zinc opens a line\n\nZinc opened a line [1].\n\n## In brief\n\n- Acme filed its report [2]\n- Bikes [3]";
		const labelled = write.labelOrigins(markdown, [
			{ n: 1, kind: "full", origin: "Announced by Zinc Corp" },
			{ n: 2, kind: "brief", origin: "Filing" },
			{ n: 3, kind: "brief", origin: null },
		]);
		assert.equal(labelled, "## Zinc opens a line\n\n*Announced by Zinc Corp*\n\nZinc opened a line [1].\n\n## In brief\n\n- *Filing:* Acme filed its report [2]\n- Bikes [3]");
		assert.deepEqual(
			write.draftParagraphs(labelled).map(({ cites }) => cites),
			[[1], [2], [3]],
			"the label is no claim, and each brief bullet is a claim of its own"
		);
	});
});

describe("the security review's findings", () => {
	const PUBLIC = async () => ["93.184.216.34"];
	const quiet = () => meter.createMeter({ budgetUsd: 1, prices: [{ model: "local-model", inputPerMillion: 0.1, outputPerMillion: 0.1 }], calls: [] });

	test("a model server's address is held to the public-address rule, and a redirect from it is an error, not followed", async () => {
		const log = [];
		const fetchImpl = respond({ "https://llm.example.com/v1/chat/completions": new Response(null, { status: 307, headers: { location: "https://169.254.169.254/latest" } }) }, log);
		const fetcher = fetching.createFetcher({ fetchImpl, resolveHost: async (host) => (host === "inside.example.com" ? ["192.168.1.20"] : ["93.184.216.34"]) });
		const base = { step: "write", model: "local-model", system: "S", user: "U", maxTokens: 10, fetchImpl, guard: fetcher.assertPublic };
		await assert.rejects(providers.callModel({ ...base, meter: quiet(), key: { keyId: "k", provider: "openai-compatible", baseUrl: "https://inside.example.com/v1", secret: SECRET } }), /private network/);
		assert.equal(log.length, 0);
		await assert.rejects(providers.callModel({ ...base, meter: quiet(), key: { keyId: "k", provider: "openai-compatible", baseUrl: "https://llm.example.com/v1", secret: SECRET } }), /answered 307/);
		assert.equal(log.length, 1);
		assert.equal(log[0].url, "https://llm.example.com/v1/chat/completions");
	});

	test("an error body adds a short, plain, scrubbed line at most", async () => {
		const noisy = `${"<script>alert(1)</script>".repeat(20)}\u0000 key ${SECRET}`;
		const fetchImpl = async () => Response.json({ error: { message: noisy } }, { status: 400 });
		const error = await providers.callModel({ step: "write", model: "gpt-4o-mini", system: "S", user: "U", maxTokens: 10, fetchImpl, meter: meter.createMeter({ budgetUsd: 1, prices: [], calls: [] }), endpoints: AI_PROVIDER_ENDPOINTS, key: { keyId: "k", provider: "openai", baseUrl: "https://api.openai.com/v1", secret: SECRET } }).catch((caught) => caught);
		assert.ok(error.message.length <= 160, error.message);
		assert.doesNotMatch(error.message, /<|\u0000/);
		assert.ok(!error.message.includes(SECRET));
	});

	test("an answer without usage is charged its max_tokens, and non-Latin text isn't under-counted", () => {
		const cap = meter.createMeter({ budgetUsd: 1, prices: [], calls: [] });
		const call = cap.record({ step: "write", provider: "openai", model: "gpt-4o-mini", usage: {}, input: "abc", output: "x".repeat(40), maxTokens: 900 });
		assert.equal(call.outputTokens, 900);
		assert.equal(cap.record({ step: "write", provider: "openai", model: "gpt-4o-mini", usage: {}, input: "abc", output: "y".repeat(8000), maxTokens: 900 }).outputTokens, 2000, "or the reply's own length when that is more");
		const cjk = "電池工場の建設が始まった。".repeat(100);
		assert.ok(meter.estimateTokens(cjk) >= Math.ceil(new TextEncoder().encode(cjk).length / 3));
		assert.equal(meter.estimateTokens("abcd".repeat(100)), 100);
	});

	test("robots.txt is read through up to five redirects, each held to the same address rules", async () => {
		robots.clearRobotsCache();
		const log = [];
		const fetchImpl = respond(
			{
				"https://site.example.com/robots.txt": new Response(null, { status: 301, headers: { location: "https://cdn.example.net/robots.txt" } }),
				"https://cdn.example.net/robots.txt": new Response("User-agent: *\nDisallow: /private\n"),
				"https://site.example.com/public": new Response("<p>ok</p>"),
				"https://other.example.com/robots.txt": new Response(null, { status: 302, headers: { location: "https://10.0.0.9/robots.txt" } }),
			},
			log
		);
		const fetcher = fetching.createFetcher({ fetchImpl, resolveHost: PUBLIC });
		await fetcher.get("https://site.example.com/public");
		await assert.rejects(fetcher.get("https://site.example.com/private/x"), /robots\.txt/);
		assert.deepEqual(
			log.map(({ url }) => url),
			["https://site.example.com/robots.txt", "https://cdn.example.net/robots.txt", "https://site.example.com/public"]
		);
		await assert.rejects(fetcher.get("https://other.example.com/x"), /robots\.txt/, "a redirect to a private address counts as unreachable");
		assert.ok(!log.some(({ url }) => url.includes("10.0.0.9")));
	});

	test("OpenAI's reasoning models get max_completion_tokens and no temperature", async () => {
		const log = [];
		const fetchImpl = respond({ "https://api.openai.com/v1/chat/completions": { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } } }, log);
		const key = { keyId: "k", provider: "openai", baseUrl: "https://api.openai.com/v1", secret: SECRET };
		const call = (model) => providers.callModel({ step: "write", model, system: "S", user: "U", maxTokens: 700, fetchImpl, meter: meter.createMeter({ budgetUsd: 1, prices: [{ model: "o4-mini", inputPerMillion: 1, outputPerMillion: 4 }], calls: [] }), endpoints: AI_PROVIDER_ENDPOINTS, key });
		await call("gpt-5-mini");
		await call("o4-mini");
		await call("gpt-4o-mini");
		assert.deepEqual(
			log.map(({ body }) => [body.max_tokens, body.max_completion_tokens, body.temperature, body.reasoning_effort]),
			[
				[undefined, 700, undefined, "minimal"],
				[undefined, 700, undefined, "low"],
				[700, undefined, 0.2, undefined],
			]
		);
	});

	test("gpt-oss models on any host are asked to reason little, and keep max_tokens and their temperature", async () => {
		const log = [];
		const fetchImpl = respond({ "https://api.groq.com/openai/v1/chat/completions": { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } } }, log);
		const key = { keyId: "k", provider: "groq", secret: SECRET };
		const prices = [{ model: "openai/gpt-oss-20b", inputPerMillion: 1, outputPerMillion: 1 }, { model: "llama-3.1-8b-instant", inputPerMillion: 1, outputPerMillion: 1 }];
		const call = (model) => providers.callModel({ step: "extract", model, system: "S", user: "U", maxTokens: 700, fetchImpl, meter: meter.createMeter({ budgetUsd: 1, prices, calls: [] }), endpoints: AI_PROVIDER_ENDPOINTS, key });
		await call("openai/gpt-oss-20b");
		await call("llama-3.1-8b-instant");
		assert.deepEqual(
			log.map(({ body }) => [body.max_tokens, body.max_completion_tokens, body.temperature, body.reasoning_effort]),
			[
				[700, undefined, 0.2, "low"],
				[700, undefined, 0.2, undefined],
			]
		);
	});

	test("an answer cut off at its cap with nothing usable is asked once more with twice the room, and both calls are charged", async () => {
		const log = [];
		const answers = [
			{ choices: [{ message: { content: "" }, finish_reason: "length" }], usage: { prompt_tokens: 100, completion_tokens: 700 } },
			{ choices: [{ message: { content: '{"what":"done"}' }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 900 } },
		];
		const fetchImpl = async (url, init) => {
			log.push({ url: String(url), body: JSON.parse(init.body) });
			return new Response(JSON.stringify(answers.shift()), { status: 200, headers: { "content-type": "application/json" } });
		};
		const calls = [];
		const m = meter.createMeter({ budgetUsd: 1, prices: [{ model: "openai/gpt-oss-20b", inputPerMillion: 1, outputPerMillion: 1 }], calls });
		const key = { keyId: "k", provider: "groq", secret: SECRET };
		const answer = await providers.callModel({ step: "extract", model: "openai/gpt-oss-20b", system: "S", user: "U", json: true, maxTokens: 700, fetchImpl, meter: m, endpoints: AI_PROVIDER_ENDPOINTS, key });
		assert.deepEqual(answer.json, { what: "done" });
		assert.deepEqual(log.map(({ body }) => body.max_tokens), [700, 1400]);
		assert.deepEqual(calls.map(({ outputTokens }) => outputTokens), [700, 900]);
	});

	test("a draft's links are checked four at a time, and the check stops and resumes when its time runs out", async () => {
		let active = 0;
		let most = 0;
		const asked = [];
		const fetcher = {
			checkLink: async (url) => {
				asked.push(url);
				active += 1;
				most = Math.max(most, active);
				await new Promise((resolve) => setTimeout(resolve, 2));
				active -= 1;
				return { url, state: "ok" };
			},
		};
		const links = Array.from({ length: 10 }, (_, index) => `https://news.example.com/${index}`);
		const states = {};
		let passes = 0;
		const first = await check.checkLinks({ links, fetcher, states, hasTime: () => passes++ < 1 });
		assert.equal(first.done, false);
		assert.equal(Object.keys(states).length, 4);
		const second = await check.checkLinks({ links, fetcher, states, hasTime: () => true });
		assert.equal(second.done, true);
		assert.equal(Object.keys(states).length, 10);
		assert.equal(new Set(asked).size, 10, "no link checked twice");
		assert.equal(most, 4);
	});

	test("links are read from the HTML the issue renders to: every href and src", () => {
		assert.deepEqual(check.renderedLinks("[a](https://a.example.com/x) and ![i](https://img.example.com/p.png)\n\n[r]: https://ref.example.com/"), ["https://a.example.com/x", "https://img.example.com/p.png"]);
		assert.equal(write.sanitizeModelMarkdown('<a href="https://x.example.com">x</a> <b>bold</b> https://bare.example.com/a www.bare.example.com [t](https://x.example.com) [r][2] [3]\n[2]: https://ref.example.com'), "x bold   t r [3]");
		assert.equal(extractModule.cleanCompany("Zinc](https://evil.example.com) <b>Corp</b> *now*"), "Zinc Corp now");
	});
});

describe("the first production run", () => {
	const groq = { keyId: "g", provider: "groq", baseUrl: "https://api.groq.com/openai/v1", secret: SECRET };
	const prices = [{ model: "openai/gpt-oss-20b", inputPerMillion: 0.1, outputPerMillion: 0.5 }];

	test("a JSON-mode answer the server couldn't validate is asked again once without response_format, and both calls are charged", async () => {
		const log = [];
		const fetchImpl = async (url, init) => {
			const body = JSON.parse(init.body);
			log.push(body);
			if (body.response_format) return Response.json({ error: { message: "Failed to validate JSON. Please adjust your prompt. See 'failed_generation' for more details.", type: "invalid_request_error", code: "json_validate_failed", failed_generation: '{"what": "half' } }, { status: 400 });
			return Response.json({ choices: [{ message: { content: 'Sure: {"what": "Acme raised money."}' } }], usage: { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280, queue_time: 0.01 } });
		};
		const calls = [];
		const result = await providers.callModel({ key: groq, model: "openai/gpt-oss-20b", step: "extract", system: "S", user: "U", json: true, maxTokens: 700, fetchImpl, meter: meter.createMeter({ budgetUsd: 1, prices, calls }), endpoints: AI_PROVIDER_ENDPOINTS });
		assert.deepEqual(result.json, { what: "Acme raised money." });
		assert.equal(log.length, 2);
		assert.deepEqual(log[0].response_format, { type: "json_object" });
		assert.equal(log[1].response_format, undefined);
		assert.deepEqual(log[1].messages, log[0].messages, "the same prompt");
		assert.equal(calls.length, 2, "the refused call is charged too, at its ceiling");
		assert.deepEqual(
			calls.map(({ inputTokens, outputTokens, costFrom }) => [inputTokens, outputTokens, costFrom]),
			[
				[1, 700, "price_table"],
				[1200, 80, "price_table"],
			]
		);

		const other = async (url, init) => {
			log.push(JSON.parse(init.body));
			return Response.json({ error: { message: "model not found" } }, { status: 400 });
		};
		log.length = 0;
		await assert.rejects(providers.callModel({ key: groq, model: "openai/gpt-oss-20b", step: "extract", system: "S", user: "U", json: true, maxTokens: 700, fetchImpl: other, meter: meter.createMeter({ budgetUsd: 1, prices, calls: [] }), endpoints: AI_PROVIDER_ENDPOINTS }), /answered 400: model not found/);
		assert.equal(log.length, 1, "any other 400 isn't asked again");
	});

	test("usage is read as each API writes it: prompt_tokens and completion_tokens, or input_tokens and output_tokens", async () => {
		const answers = [
			{ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 321, completion_tokens: 45, total_tokens: 366 } },
			{ choices: [{ message: { content: "ok" } }], usage: { input_tokens: 111, output_tokens: 22 } },
			{ choices: [{ message: { content: "ok" } }], x_groq: { usage: { prompt_tokens: 77, completion_tokens: 7 } } },
		];
		const recorded = [];
		for (const answer of answers) {
			const calls = [];
			await providers.callModel({ key: groq, model: "openai/gpt-oss-20b", step: "write", system: "S", user: "U", maxTokens: 900, fetchImpl: async () => Response.json(answer), meter: meter.createMeter({ budgetUsd: 1, prices, calls }), endpoints: AI_PROVIDER_ENDPOINTS });
			recorded.push([calls[0].inputTokens, calls[0].outputTokens]);
		}
		assert.deepEqual(recorded, [
			[321, 45],
			[111, 22],
			[77, 7],
		]);
	});
});
