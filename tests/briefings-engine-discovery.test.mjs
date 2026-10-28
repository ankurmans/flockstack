import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startTestApp } from "./helpers/app.mjs";

// Discovery's parts on their own (docs/BRIEFINGS-DESIGN.md, Open-web discovery and Ranking): each adapter's request and answer,
// the pacing counters and every limit's scope, the provider's fetch, the ranker's switch from fixed to fitted weights, story
// kinds, step budget shares and hold reasons. No network: every fetch is a stub.

let app;
let m;
const NOW = new Date("2026-10-28T09:00:00Z");
const SECRET = "tf_test_0011223344556677SECRET";

// What fetcher.api answers: { status, headers, text }.
function api(status, body, headers = {}) {
	return { status, headers: new Headers(headers), text: typeof body === "string" ? body : JSON.stringify(body) };
}

function recorder(answer) {
	const calls = [];
	const fetchImpl = async (url, init = {}) => {
		calls.push({ url, ...init, body: init.body ? JSON.parse(init.body) : undefined });
		return typeof answer === "function" ? answer(url, init) : answer;
	};
	return { calls, fetchImpl };
}

before(async () => {
	app = await startTestApp();
	const docdb = await import("../lib/docdb/index.js");
	m = {
		ObjectId: docdb.ObjectId,
		errors: await import("../lib/briefings/discovery/errors.js"),
		gdelt: (await import("../lib/briefings/discovery/gdelt.js")).default,
		parseSeenDate: (await import("../lib/briefings/discovery/gdelt.js")).parseSeenDate,
		hn: (await import("../lib/briefings/discovery/hn.js")).default,
		tinyfish: (await import("../lib/briefings/discovery/tinyfish.js")).default,
		candidateFeed: (await import("../lib/briefings/discovery/candidate-feed.js")).default,
		outletFeeds: await import("../lib/briefings/discovery/outlet-feeds.js"),
		discovery: await import("../lib/briefings/discovery/index.js"),
		pacing: await import("../lib/briefings/discovery/pacing.js"),
		rank: await import("../lib/briefings/rank.js"),
		triage: await import("../lib/briefings/triage.js"),
		stages: await import("../lib/briefings/stages.js"),
		meter: await import("../lib/briefings/meter.js"),
		prompts: await import("../lib/briefings/prompts.js"),
		DiscoveryUsage: (await import("../models/DiscoveryUsage.js")).default,
	};
});

after(() => app?.stop());

describe("the adapters", () => {
	test("GDELT: the article list for a quoted phrase, a site and a language, its dates read; its five-second rule is a minute's limit", async () => {
		const { calls, fetchImpl } = recorder(api(200, { articles: [{ url: "https://news.example.com/a", url_mobile: "", title: "Acme raises money", seendate: "20261028T081500Z", domain: "news.example.com", language: "English" }] }));
		const answer = await m.gdelt.search({ query: "battery plant", site: "news.example.com", since: "2026-10-27T09:00:00Z", language: "en", max: 10 }, { fetchImpl, now: NOW });
		const params = new URL(calls[0].url).searchParams;
		assert.equal(new URL(calls[0].url).origin + new URL(calls[0].url).pathname, "https://api.gdeltproject.org/api/v2/doc/doc");
		assert.deepEqual(Object.fromEntries(params), { query: '"battery plant" domain:news.example.com sourcelang:en', mode: "artlist", format: "json", maxrecords: "10", sort: "datedesc", startdatetime: "20261027090000", enddatetime: "20261028090000" });
		assert.deepEqual(answer.results, [{ url: "https://news.example.com/a", title: "Acme raises money", snippet: "", publishedAt: "2026-10-28T08:15:00.000Z", publisher: "news.example.com" }]);
		assert.deepEqual(answer.usage, { requests: 1, costUsd: 0 });
		assert.equal(m.parseSeenDate("bad"), null);
		const slow = recorder(api(200, "Please limit requests to one every 5 seconds or contact us for larger queries."));
		const error = await m.gdelt.search({ query: "acme" }, { fetchImpl: slow.fetchImpl, now: NOW }).catch((caught) => caught);
		assert.ok(error instanceof m.errors.DiscoveryLimitError);
		assert.deepEqual([error.scope, error.retryAfterMs], ["minute", 5000]);
		assert.equal(m.gdelt.minIntervalMs, 5000);
	});

	test("Hacker News: one search_by_date request, stories since the cut-off, a link-less story as its own discussion", async () => {
		const { calls, fetchImpl } = recorder(
			api(200, {
				hits: [
					{ objectID: "11", url: "https://blog.example.com/post", title: "A post", created_at: "2026-10-28T07:00:00Z" },
					{ objectID: "12", url: null, title: "Ask HN: batteries?", story_text: "<p>What do you <i>think</i>?</p>", created_at: "2026-10-28T06:00:00Z" },
				],
			})
		);
		const answer = await m.hn.search({ query: "battery", since: "2026-10-27T09:00:00Z", max: 10 }, { fetchImpl, now: NOW });
		assert.equal(calls.length, 1);
		assert.deepEqual(Object.fromEntries(new URL(calls[0].url).searchParams), { query: "battery", tags: "story", hitsPerPage: "10", numericFilters: "created_at_i>1793091600" });
		assert.deepEqual(
			answer.results.map(({ url, publisher, snippet }) => [url, publisher, snippet]),
			[
				["https://blog.example.com/post", "", ""],
				["https://news.ycombinator.com/item?id=12", "news.ycombinator.com", "What do you think ?"],
			]
		);
		assert.deepEqual(m.hn.limits, { hour: 10_000 });
	});

	test("TinyFish Search: the key in X-API-Key, news results, and its rate headers and status codes read", async () => {
		const paced = [];
		const { calls, fetchImpl } = recorder(api(200, { query: "acme", results: [{ position: 1, site_name: "news.example.com", title: "Acme", snippet: "Acme raised money.", url: "https://news.example.com/a", date: "2026-10-28", publisher: "News" }], total_results: 1, page: 0 }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1793178060" }));
		const ctx = { key: { secret: SECRET }, fetchImpl, now: NOW, pace: (scope, info) => paced.push({ scope, ...info }) };
		const answer = await m.tinyfish.search({ query: "acme", site: "news.example.com", since: "2026-10-27T09:00:00Z", language: "en", max: 5 }, ctx);
		assert.equal(new URL(calls[0].url).origin, "https://api.search.tinyfish.ai");
		assert.deepEqual(Object.fromEntries(new URL(calls[0].url).searchParams), { query: "acme", domain_type: "news", include_domains: "news.example.com", language: "en", after_date: "2026-10-27" });
		assert.equal(calls[0].headers["x-api-key"], SECRET);
		assert.deepEqual(answer.results, [{ url: "https://news.example.com/a", title: "Acme", snippet: "Acme raised money.", publishedAt: "2026-10-28T00:00:00.000Z", publisher: "News" }]);
		assert.deepEqual(paced, [{ scope: "minute", operation: "search", remaining: 0, resetAt: new Date(1793178060 * 1000) }]);
		const answers = { 401: m.errors.DiscoveryAuthError, 402: m.errors.DiscoveryLimitError, 429: m.errors.DiscoveryLimitError, 500: m.errors.DiscoveryError };
		for (const [status, kind] of Object.entries(answers)) {
			const failing = recorder(api(Number(status), { error: { message: `nope ${SECRET}` } }, { "retry-after": "7" }));
			const error = await m.tinyfish.search({ query: "acme" }, { ...ctx, fetchImpl: failing.fetchImpl }).catch((caught) => caught);
			assert.ok(error instanceof kind, status);
			assert.ok(!error.message.includes(SECRET));
			if (status === "402") assert.equal(error.scope, "day", "a 402 is the day's free allowance: never the wallet");
			if (status === "429") assert.deepEqual([error.scope, error.retryAfterMs], ["minute", 7000]);
		}
		assert.deepEqual([m.tinyfish.limits, m.tinyfish.fetchLimits], [{ minute: 30, hour: 500 }, { minute: 150, day: 1000 }]);
	});

	test("TinyFish Fetch: one URL as Markdown with its links; a bot block or login wall is a refusal, not text", async () => {
		const { calls, fetchImpl } = recorder(api(200, { results: [{ url: "https://app.example.com/a", final_url: "https://app.example.com/a/", title: "A", text: "# A\n\nText.", links: ["https://x.example.com/"] }], errors: [] }));
		const page = await m.tinyfish.fetch({ url: "https://app.example.com/a" }, { key: { secret: SECRET }, fetchImpl, now: NOW });
		assert.equal(calls[0].url, "https://api.fetch.tinyfish.ai");
		assert.equal(calls[0].method, "POST");
		assert.deepEqual(calls[0].body, { urls: ["https://app.example.com/a"], format: "markdown", links: true });
		assert.equal(calls[0].headers["x-api-key"], SECRET);
		assert.deepEqual([page.finalUrl, page.text, page.links], ["https://app.example.com/a/", "# A\n\nText.", ["https://x.example.com/"]]);
		const blocked = recorder(api(200, { results: [], errors: [{ url: "https://app.example.com/a", error: "bot_blocked" }] }));
		const refused = await m.tinyfish.fetch({ url: "https://app.example.com/a" }, { key: { secret: SECRET }, fetchImpl: blocked.fetchImpl, now: NOW });
		assert.deepEqual([refused.refused, refused.text], [true, ""]);
	});

	test("a candidate feed: GET with a bearer key, its items mapped, a refused key an auth error", async () => {
		const { calls, fetchImpl } = recorder(api(200, { items: [{ url: "https://bsky.app/profile/a/post/1", title: "A post", snippet: "Hi", publishedAt: "2026-10-28T08:00:00Z", publisher: "Bluesky" }] }));
		const key = { secret: SECRET, baseUrl: "https://signals.example.com/briefing.json?list=7" };
		const answer = await m.candidateFeed.search({ since: "2026-10-27T09:00:00Z" }, { key, fetchImpl, now: NOW });
		assert.equal(calls[0].url, "https://signals.example.com/briefing.json?list=7&since=2026-10-27T09%3A00%3A00.000Z");
		assert.equal(calls[0].headers.authorization, `Bearer ${SECRET}`);
		assert.deepEqual(answer.results[0], { url: "https://bsky.app/profile/a/post/1", title: "A post", snippet: "Hi", publishedAt: "2026-10-28T08:00:00.000Z", publisher: "Bluesky" });
		assert.equal(m.candidateFeed.perQuery, false, "read once a run, not once per query");
		const refused = recorder(api(403, "no"));
		await assert.rejects(m.candidateFeed.search({}, { key, fetchImpl: refused.fetchImpl, now: NOW }), m.errors.DiscoveryAuthError);
	});

	test("outlet feeds: a home page read once for its feed link, which comes back to be kept; a known feed read directly", async () => {
		const pages = {
			"https://news.example.com/": { url: "https://news.example.com/", text: '<link rel="alternate" type="application/rss+xml" title="RSS" href="/rss.xml">' },
			"https://news.example.com/rss.xml": { url: "https://news.example.com/rss.xml", text: '<rss version="2.0"><channel><item><title>New</title><link>https://news.example.com/new</link><pubDate>Wed, 28 Oct 2026 08:00:00 GMT</pubDate></item><item><title>Old</title><link>https://news.example.com/old</link><pubDate>Mon, 26 Oct 2026 08:00:00 GMT</pubDate></item></channel></rss>' },
			"https://blog.example.org/feed.json": { url: "https://blog.example.org/feed.json", text: JSON.stringify({ version: "https://jsonfeed.org/version/1.1", items: [{ url: "https://blog.example.org/post", title: "Post", date_published: "2026-10-28T07:00:00Z" }] }) },
			"https://nofeed.example.com/": { url: "https://nofeed.example.com/", text: "<html></html>" },
		};
		const asked = [];
		const fetchPage = async (url) => {
			asked.push(url);
			if (!pages[url]) throw new Error("answered 404");
			return pages[url];
		};
		const answer = await m.outletFeeds.default.search({ since: "2026-10-27T09:00:00Z" }, { fetchPage, outlets: [{ host: "news.example.com" }, { host: "blog.example.org", feedUrl: "https://blog.example.org/feed.json" }, { host: "nofeed.example.com" }, { host: "gone.example.com", feedUrl: "" }] });
		assert.deepEqual(
			answer.results.map(({ url, publisher }) => [url, publisher]),
			[
				["https://news.example.com/new", "news.example.com"],
				["https://blog.example.org/post", "blog.example.org"],
			]
		);
		assert.deepEqual(answer.feeds, { "news.example.com": "https://news.example.com/rss.xml", "nofeed.example.com": "" });
		assert.ok(!asked.some((url) => url.includes("gone.example.com")), "a host known to have no feed isn't asked again");
		assert.equal(m.outletFeeds.findFeedLink('<link rel="alternate" type="application/atom+xml" href="http://x.example.com/atom">', "https://x.example.com/"), null, "only an https feed");
	});
});

describe("pacing", () => {
	const scope = () => {
		const accountId = new m.ObjectId();
		return { accountId, provider: "tinyfish", keyId: `k1-${accountId}`, operation: "search", now: NOW };
	};

	test("a slot is taken in every window; the full one gives the others back and says until when", async () => {
		const base = scope();
		const limits = { minute: 2, hour: 3 };
		assert.deepEqual(await m.pacing.takeSlot({ ...base, limits }), { ok: true });
		assert.deepEqual(await m.pacing.takeSlot({ ...base, limits }), { ok: true });
		assert.deepEqual(await m.pacing.takeSlot({ ...base, limits }), { ok: false, scope: "minute", until: new Date("2026-10-28T09:01:00Z") });
		const later = new Date(NOW.getTime() + 61_000);
		assert.deepEqual(await m.pacing.takeSlot({ ...base, limits, now: later }), { ok: true });
		assert.deepEqual(await m.pacing.takeSlot({ ...base, limits, now: new Date(NOW.getTime() + 125_000) }), { ok: false, scope: "hour", until: new Date("2026-10-28T10:00:00Z") });
		const rows = await m.DiscoveryUsage.find({ accountId: base.accountId }).lean();
		assert.equal(rows.find(({ window }) => window === "hour").count, 3, "the refused request gave its slot back");
	});

	test("two briefings on one key share it; another key, operation or account doesn't; an exhausted window waits for its reset", async () => {
		const base = scope();
		const limits = { minute: 1 };
		assert.equal((await m.pacing.takeSlot({ ...base, limits })).ok, true);
		assert.equal((await m.pacing.takeSlot({ ...base, limits })).ok, false);
		assert.equal((await m.pacing.takeSlot({ ...base, keyId: `${base.keyId}-2`, limits })).ok, true);
		assert.equal((await m.pacing.takeSlot({ ...base, operation: "fetch", limits })).ok, true);
		assert.equal((await m.pacing.takeSlot({ ...base, provider: "gdelt", keyId: "", limits })).ok, true);
		assert.equal((await m.pacing.takeSlot({ ...base, accountId: new m.ObjectId(), provider: "gdelt", keyId: "", limits })).ok, true, "free indexes are paced per account");
		const until = new Date("2026-10-29T00:00:00Z");
		await m.pacing.markExhausted({ ...base, keyId: `${base.keyId}-3`, scope: "day", until });
		assert.deepEqual(await m.pacing.takeSlot({ ...base, keyId: `${base.keyId}-3`, limits: {} }), { ok: false, scope: "day", until });
	});
});

describe("calling an adapter", () => {
	function ctxFor({ accountId = new m.ObjectId(), timeLeft = 300_000 } = {}) {
		const sleeps = [];
		const notes = [];
		const rejected = [];
		const ctx = {
			run: { accountId, discoveryNotes: notes },
			work: { discovery: { off: {}, lastAt: {}, errors: {}, pending: [], costUsd: 0 } },
			clock: () => NOW,
			canWait: (ms) => timeLeft > ms + 5000,
			sleep: async (ms) => sleeps.push(ms),
			fetcher: { api: async () => api(200, "{}"), get: async () => ({}) },
			keyRejected: async (info) => rejected.push(info),
		};
		return { ctx, sleeps, notes, rejected };
	}

	test("a minute's limit is waited when it fits, carried when it doesn't; an hour's turns the provider off; a refused key is reported", async () => {
		let attempts = 0;
		const original = m.discovery.ADAPTERS.tinyfish.search;
		try {
			m.discovery.ADAPTERS.tinyfish.search = async () => {
				attempts += 1;
				if (attempts === 1) throw new m.errors.DiscoveryLimitError("429", { scope: "minute", retryAfterMs: 3000 });
				return { results: [], usage: { requests: 1, costUsd: 0 } };
			};
			const waited = ctxFor();
			const provider = { id: "tinyfish", key: { secret: SECRET }, keyId: "k-wait" };
			assert.ok((await m.discovery.callAdapter(waited.ctx, { provider, args: { query: "a" } })).value);
			assert.deepEqual(waited.sleeps, [3000]);

			attempts = 0;
			const short = ctxFor({ timeLeft: 4000 });
			assert.deepEqual(await m.discovery.callAdapter(short.ctx, { provider: { ...provider, keyId: "k-short" }, args: { query: "a" } }), { carry: true });

			m.discovery.ADAPTERS.tinyfish.search = async () => {
				throw new m.errors.DiscoveryLimitError("hourly", { scope: "hour" });
			};
			const hourly = ctxFor();
			assert.deepEqual(await m.discovery.callAdapter(hourly.ctx, { provider: { ...provider, keyId: "k-hour" }, args: { query: "a" } }), { skip: true });
			assert.equal(hourly.ctx.work.discovery.off.tinyfish, "2026-10-28T10:00:00.000Z");
			assert.deepEqual(hourly.notes.map(({ scope }) => scope), ["hour"]);
			assert.deepEqual(await m.discovery.callAdapter(hourly.ctx, { provider: { ...provider, keyId: "k-hour" }, args: { query: "b" } }), { skip: true }, "not asked again in the window");

			m.discovery.ADAPTERS.tinyfish.search = async () => {
				throw new m.errors.DiscoveryAuthError(`TinyFish search refused the key ${SECRET}`);
			};
			const refused = ctxFor();
			await m.discovery.callAdapter(refused.ctx, { provider: { ...provider, keyId: "k-bad" }, args: { query: "a" } });
			assert.deepEqual(refused.rejected, [{ keyId: "k-bad", provider: "tinyfish" }]);
			assert.equal(refused.ctx.work.partial, true);
			assert.ok(!refused.notes[0].problem.includes(SECRET), refused.notes[0].problem);
		} finally {
			m.discovery.ADAPTERS.tinyfish.search = original;
		}
	});

	test("the provider's fetch is asked only after robots.txt allows the page, and never for a blocked host", async () => {
		const asked = [];
		const original = m.discovery.ADAPTERS.tinyfish.fetch;
		try {
			m.discovery.ADAPTERS.tinyfish.fetch = async ({ url }) => {
				asked.push(url);
				return { url, finalUrl: url, status: 200, text: "Text", links: [] };
			};
			const { ctx } = ctxFor();
			Object.assign(ctx, {
				briefing: { discovery: { searchKeyId: "k-fetch" } },
				searchKey: async () => ({ provider: "tinyfish", secret: SECRET }),
				fetcher: { ...ctx.fetcher, isBlocked: (url) => url.includes("blocked"), allowedByRobots: async (url) => !url.includes("private") },
			});
			const fetchPage = m.discovery.providerFetcher(ctx);
			assert.equal(await fetchPage("https://shy.example.com/private/page"), null);
			assert.equal(await fetchPage("https://blocked.example.com/page"), null);
			assert.deepEqual(await fetchPage("https://app.example.com/page"), { text: "Text", title: undefined, links: [], finalUrl: "https://app.example.com/page" });
			assert.deepEqual(asked, ["https://app.example.com/page"]);
		} finally {
			m.discovery.ADAPTERS.tinyfish.fetch = original;
		}
	});

	test("the funnel's widths come from the briefing, held to their maximums", () => {
		assert.deepEqual(m.discovery.discoverySettings({}), { maxQueries: 16, resultsPerQuery: 10, maxCandidates: 300, shortlist: 40, followLinks: 5, discoveryBudgetUsd: 0, lookbackHours: 30, mondayLookbackHours: 72 });
		assert.deepEqual(m.discovery.discoverySettings({ discovery: { maxQueries: 99, shortlist: 10, followLinks: 0 } }), { maxQueries: 40, resultsPerQuery: 10, maxCandidates: 300, shortlist: 10, followLinks: 0, discoveryBudgetUsd: 0, lookbackHours: 30, mondayLookbackHours: 72 });
	});
});

describe("ranking", () => {
	const features = (keep, trusted) => ({ relevance: keep ? 0.9 : 0.2, usefulness: keep ? 0.8 : 0.1, novelty: 0.5, primary: 0.5, exampleSim: keep ? 0.6 : 0.1, pastSim: 0, publisher: 0, trusted, independent: 0, recency: 0.5 });
	const verdicts = (count) => Array.from({ length: count }, (_, index) => ({ verdict: index % 3 === 0 ? "drop" : "keep", features: features(index % 3 !== 0, index % 3 === 0 ? 1 : 0) }));

	test("fixed weights until 30 verdicts, then a logistic model fitted on them, the same every time", () => {
		assert.equal(m.rank.rankModel(verdicts(29)).kind, "fixed");
		assert.equal(m.rank.rankModel(verdicts(40).map((verdict) => ({ ...verdict, verdict: "keep" }))).kind, "fixed", "one kind of answer can't be fitted");
		const fitted = m.rank.rankModel(verdicts(30));
		assert.equal(fitted.kind, "fitted");
		assert.deepEqual(m.rank.rankModel(verdicts(30)), fitted, "deterministic");
		assert.ok(fitted.weights.relevance > 0 && fitted.weights.usefulness > 0);
		assert.equal(fitted.weights.trusted, 0, "the owner dropped every trusted story, yet a trusted outlet never counts against one");
		const keep = m.rank.scoreFeatures(features(true, 0), fitted);
		const drop = m.rank.scoreFeatures(features(false, 0), fitted);
		assert.ok(keep > 70 && drop < 40, `${keep} ${drop}`);
		assert.equal(m.rank.scoreFeatures({ ...features(true, 0) }, { kind: "fixed", weights: m.rank.FIXED_WEIGHTS, bias: 0 }), 57.8);
	});

	test("full stories over minScore, then brief items a little under it", () => {
		const scored = [90, 80, 70, 65, 55, 50, 30].map((score, index) => ({ key: `s${index}`, score }));
		const picks = m.triage.pickStories(scored, { minScore: 60, minFull: 2, maxFull: 3, briefItems: 2 });
		assert.deepEqual(
			picks.full.map(({ score, kind }) => [score, kind]),
			[
				[90, "full"],
				[80, "full"],
				[70, "full"],
			]
		);
		assert.deepEqual(
			picks.brief.map(({ score, kind }) => [score, kind]),
			[
				[65, "brief"],
				[55, "brief"],
			]
		);
		assert.equal(m.stages.storySettings({}).minFull, 6);
		assert.deepEqual(m.stages.storySettings({ stories: { minFull: 12, maxFull: 4, briefItems: 50 } }), { minFull: 4, maxFull: 4, briefItems: 20 });
	});
});

describe("budget shares and holds", () => {
	test("a step can't spend more than its share, even with the run's budget left", () => {
		const calls = [];
		const cap = m.meter.createMeter({ budgetUsd: 1, stepBudgets: { translate: 1 }, prices: [{ model: "x", inputPerMillion: 5, outputPerMillion: 0 }], calls });
		assert.ok(cap.admit({ step: "translate", provider: "openai", model: "x", inputChars: 4000, maxTokens: 0 }) <= 0.01);
		const error = (() => {
			try {
				cap.admit({ step: "translate", provider: "openai", model: "x", inputChars: 80_000, maxTokens: 0 });
			} catch (caught) {
				return caught;
			}
		})();
		assert.ok(error instanceof m.meter.BudgetStop);
		assert.deepEqual([error.step, error.scope], ["translate", "step"]);
		assert.equal(cap.shareOf("extract"), 0.35, "the default share when the briefing sets none");
	});

	test("hold reasons, the most serious first; only a clean run in send mode may send", () => {
		const hold = (run, work = {}, briefing = { reviewMode: "send_if_checks_pass" }) => m.stages.holdReason({ run, work, briefing });
		const clean = [{ id: "numbers", status: "pass" }];
		assert.equal(hold({ thin: true, checks: [{ status: "blocker" }] }, { partial: true }), "thin");
		assert.equal(hold({ checks: [{ status: "blocker" }] }, { partial: true }), "partial");
		assert.equal(hold({ checks: [{ status: "warning" }] }), "checks");
		assert.equal(hold({ checks: clean }, {}, { reviewMode: "draft" }), "review_mode");
		assert.equal(hold({ checks: clean }), null);
	});

	test("the translate prompt keeps the citations and Markdown, and the page text stays data", () => {
		const { system, user, maxTokens } = m.prompts.translatePrompt({ markdown: "## A\n\nText [1].", subject: "S", previewText: "P", language: "French" });
		assert.match(system, /into French/);
		assert.match(system, /keep every citation like \[3\]/);
		assert.match(user, /^<<<DATA issue>>>\nSubject: S\nPreview: P\n\n## A\n\nText \[1\]\.\n<<<END DATA>>>$/);
		assert.ok(maxTokens > 200);
	});
});

describe("the discovery budget", () => {
	test("with discoveryBudgetUsd at 0, a paid adapter is never called", async () => {
		const original = m.discovery.ADAPTERS.tinyfish.paid;
		const search = m.discovery.ADAPTERS.tinyfish.search;
		let called = 0;
		try {
			m.discovery.ADAPTERS.tinyfish.paid = true;
			m.discovery.ADAPTERS.tinyfish.search = async () => {
				called += 1;
				return { results: [], usage: { requests: 1, costUsd: 0.01 } };
			};
			const notes = [];
			const ctx = { briefing: {}, run: { accountId: new m.ObjectId(), discoveryNotes: notes }, work: { discovery: { off: {}, lastAt: {}, errors: {}, pending: [], costUsd: 0 } }, clock: () => NOW, canWait: () => true, sleep: async () => {}, fetcher: {} };
			assert.deepEqual(await m.discovery.callAdapter(ctx, { provider: { id: "tinyfish", key: { secret: SECRET }, keyId: "k-paid" }, args: { query: "a" } }), { skip: true });
			assert.equal(called, 0);
			assert.deepEqual(notes.map(({ scope, problem }) => [scope, problem]), [["budget", "Paid search is off: the briefing's discovery budget is $0"]]);
		} finally {
			m.discovery.ADAPTERS.tinyfish.paid = original;
			m.discovery.ADAPTERS.tinyfish.search = search;
		}
	});
});

describe("the merge after triage", () => {
	const story = (key, title, score) => ({ key, title, score, url: `https://${key}.example.com/`, sources: [{ urlHash: key, host: `${key}.example.com`, sourceKind: null }], foundBy: [key] });

	test("the same company and the same kind of event make one story; the same company doing something else doesn't", async () => {
		const merge = await import("../lib/briefings/merge.js");
		const stories = [
			story("a", "AmTrust acquires Wakam in European expansion", 90),
			story("b", "AmTrust International acquires Wakam", 80),
			story("c", "The Hartford reports third-quarter profit jump", 70),
			story("d", "Hartford Q3: commercial lines drive results", 65),
			story("e", "Hartford launches a cyber product for small firms", 60),
			story("f", "City council approves new bike lanes", 55),
			story("g", "City budget passes after long debate", 50),
		];
		const merged = merge.mergeDuplicates(stories);
		assert.deepEqual(
			merged.map(({ key, mergedKeys }) => [key, mergedKeys ?? []]),
			[
				["a", ["b"]],
				["c", ["d"]],
				["e", []],
				["f", []],
				["g", []],
			]
		);
		assert.deepEqual(
			merged[0].sources.map(({ urlHash }) => urlHash),
			["a", "b"],
			"the better scored story's primary stays first"
		);
		assert.equal(merge.mergeDuplicates([story("x", "Insurers raise rates", 1), story("y", "Insurers cut rates", 1)]).length, 2, "a capitalised first word alone isn't a name");
	});

	test("embeddings closer than 0.78 merge stories with nothing else in common", async () => {
		const merge = await import("../lib/briefings/merge.js");
		const merged = merge.mergeDuplicates([story("a", "Lloyd's market posts a strong year", 9), story("b", "A good twelve months in One Lime Street", 8)], { similar: { a: ["b"] } });
		assert.equal(merged.length, 1);
		assert.equal(merge.SIMILAR, 0.78);
	});

	test("Title Case subjects are told apart from sentence case with names in it", async () => {
		const check = await import("../lib/briefings/check.js");
		assert.equal(check.isTitleCase("Acme Raises Money: Battery Plants Next"), true);
		assert.equal(check.isTitleCase("AmTrust acquires Wakam in European expansion"), false);
		assert.equal(check.isTitleCase("The Hartford reports a strong third quarter"), false);
	});
});

describe("the engine's own key reader", () => {
	test("reads every kind of key lib/ai-keys.js saves to the same key and address, and its address table is the same", async () => {
		const crypto = await import("node:crypto");
		const previous = process.env.CREDENTIALS_ENCRYPTION_KEY;
		process.env.CREDENTIALS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
		try {
			const store = await import("../lib/ai-keys.js");
			const deps = await import("../lib/briefings/deps.js");
			assert.deepEqual(deps.PROVIDER_ENDPOINTS, store.AI_PROVIDER_ENDPOINTS);
			const Account = (await import("../models/Account.js")).default;
			const account = await Account.create({ ownerId: new m.ObjectId() });
			const inputs = [
				{ name: "OpenAI", provider: "openai", key: "sk-test-aaaaaaaaaaaaaaaa" },
				{ name: "Cloudflare", provider: "cloudflare", accountRef: "0123456789ABCDEF0123456789abcdef", key: "cf-test-bbbbbbbbbbbbbbbb" },
				{ name: "Local", provider: "openai-compatible", baseUrl: "https://llm.example.com/v1/", key: "lc-test-cccccccccccccccc" },
				{ name: "Feed", provider: "candidate-feed", baseUrl: "https://signals.example.com/feed.json", key: "cd-test-dddddddddddddddd" },
				{ name: "TinyFish", provider: "tinyfish", key: "tf-test-eeeeeeeeeeeeeeee" },
			];
			for (const input of inputs) {
				const { id } = await store.addAiKey(account, input);
				const theirs = await store.getAiKeyForRun({ accountId: account._id, keyId: id });
				const ours = await deps.getKeyForRun({ accountId: account._id, keyId: id });
				assert.deepEqual(ours, theirs, input.provider);
				assert.equal(ours.secret, input.key);
			}
			assert.equal(await deps.getKeyForRun({ accountId: account._id, keyId: "not-an-id" }), null);
		} finally {
			if (previous === undefined) delete process.env.CREDENTIALS_ENCRYPTION_KEY;
			else process.env.CREDENTIALS_ENCRYPTION_KEY = previous;
		}
	});
});

describe("query planning", () => {
	test("each trusted outlet gets one of the run's own queries, in turn, never the topic paragraph", async () => {
		const topic = "Commercial insurance and the technology around it: commercial lines, specialty and E&S, MGAs and program business";
		const ctx = {
			briefing: { name: "Daily", brief: { topic }, trustedOutlets: ["a.example", "b.example", "c.example"], steps: { query: { keyId: "k", model: "m" } } },
			keyFor: async () => ({ key: { provider: "groq" }, model: "m" }),
			models: { text: async () => ({ json: { queries: [{ text: "MGA capacity 2026", angle: "capacity" }, { text: "cat bond issuance", angle: "ILS" }] } }) },
			describe: (error) => String(error?.message ?? error),
			work: {},
			run: { discoveryNotes: [] },
		};
		const queries = await m.discovery.planQueries(ctx, { settings: { maxQueries: 16 }, kept: [] });
		const sites = queries.filter(({ site }) => site);
		assert.deepEqual(sites.map(({ site, text }) => [site, text]), [
			["a.example", "MGA capacity 2026"],
			["b.example", "cat bond issuance"],
			["c.example", "MGA capacity 2026"],
		]);
		assert.ok(!queries.some(({ site, text }) => site && text === topic.slice(0, 120)));
	});
});
