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
	test("keeps the feed fetcher's limits", async () => {
		const { FEED_LIMITS } = await import("../lib/feed-fetch.js");
		assert.equal(fetching.FETCH_LIMITS.bytes, FEED_LIMITS.bytes);
		assert.equal(fetching.FETCH_LIMITS.timeoutMs, FEED_LIMITS.timeoutMs);
		assert.equal(fetching.FETCH_LIMITS.redirects, FEED_LIMITS.redirects);
		assert.equal(fetching.FETCH_LIMITS.perHost, 2);
		assert.equal(fetching.FETCH_LIMITS.perRun, 300);
	});

	test("refuses private and plain http addresses before any request, and checks every redirect", async () => {
		robots.clearRobotsCache();
		const log = [];
		const fetcher = fetching.createFetcher({
			fetchImpl: respond({ "https://news.example.com/moved": new Response(null, { status: 301, headers: { location: "https://169.254.169.254/latest/meta-data" } }) }, log),
		});
		await assert.rejects(fetcher.get("https://10.0.0.1/page"), /private network/);
		await assert.rejects(fetcher.get("https://localhost/page"), /private network/);
		await assert.rejects(fetcher.get("http://news.example.com/page"), /https/);
		assert.equal(log.length, 0);
		await assert.rejects(fetcher.get("https://news.example.com/moved"), /redirects to an address FlockStack can't read: That address is inside a private network/);
		assert.deepEqual(
			log.map(({ url }) => url),
			["https://news.example.com/robots.txt", "https://news.example.com/moved"]
		);
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
		const fetcher = fetching.createFetcher({ fetchImpl, used: 290 });
		await Promise.all(Array.from({ length: 6 }, (_, index) => fetcher.get(`https://one.example.com/${index}`)));
		assert.equal(most, 2);
		await assert.rejects(fetcher.get("https://one.example.com/big"), /over 1 MB/);
		assert.equal(fetcher.count, 298, "290 from earlier ticks, robots.txt once, six pages and the big one");
		await fetcher.get("https://one.example.com/7");
		await fetcher.get("https://one.example.com/8");
		await assert.rejects(fetcher.get("https://one.example.com/9"), /reached its 300 fetches/);
		assert.equal(fetcher.count, 300);
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
		assert.deepEqual(prices.findPrice({ provider: "typesafe", model: "jev-latest" }), { inputPerMillion: 0.042, outputPerMillion: 0, from: "table" });
		assert.deepEqual(prices.findPrice({ provider: "openai", model: "gpt-4o-mini", prices: [{ model: "gpt-4o-mini", inputPerMillion: 1, outputPerMillion: 2 }] }), { inputPerMillion: 1, outputPerMillion: 2, from: "briefing" });
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

describe("grouping", () => {
	const items = [
		{ title: "Acme raises $40 million for battery plant", url: "https://a.example.com/1", urlHash: "a", weight: 1, publisher: "A" },
		{ title: "Acme lands $40 million to build battery plant", url: "https://b.example.com/1", urlHash: "b", weight: 2, publisher: "B" },
		{ title: "City approves bike lanes", url: "https://c.example.com/1", urlHash: "c", weight: 1, publisher: "C" },
	];

	test("without the binding, items sharing most of their title's words are one story, led by the weightiest", () => {
		const stories = group.groupItems(items, null);
		assert.equal(stories.length, 2);
		assert.deepEqual(stories[0].items.map(({ urlHash }) => urlHash), ["b", "a"]);
		assert.deepEqual(stories[0].sources, ["B", "A"]);
		assert.equal(stories[0].url, "https://b.example.com/1");
	});

	test("with embeddings, the similarity threshold decides", async () => {
		const ai = { run: async (model, { text: list }) => ({ data: list.map((value) => (value.startsWith("City") ? [0, 1] : value.includes("raises") ? [1, 0] : [0.8, 0.6])) }) };
		const vectors = await group.embedItems(ai, items);
		assert.ok(group.cosine(vectors[0], vectors[1]) < group.SIMILARITY);
		assert.equal(group.groupItems(items, vectors).length, 3);
	});
});
