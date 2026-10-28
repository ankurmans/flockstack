import { DiscoveryAuthError, DiscoveryError, DiscoveryLimitError, parseJson, result } from "./errors.js";

// TinyFish Search and Fetch (docs.tinyfish.ai: Search API Reference, Fetch API Reference), on the account's own key and under
// the key holder's own TinyFish terms. Auth is the X-API-Key header. Both send X-RateLimit-Remaining and X-RateLimit-Reset
// (Unix seconds) and, on a 429, Retry-After in seconds. A 402 means the free daily allowance is used up: the engine never lets
// it spill onto the key holder's wallet, so it counts as the day's limit. Fetch is asked only for a page the engine's own fetch
// got but could not read as text, after the same robots.txt check, never for a page that refused us.
const SEARCH = "https://api.search.tinyfish.ai";
const FETCH = "https://api.fetch.tinyfish.ai";
const UNREADABLE = new Set(["bot_blocked", "login_required", "invalid_url", "invalid_redirect_url"]);

function report(response, ctx, operation) {
	const remaining = Number(response.headers.get("x-ratelimit-remaining"));
	const reset = Number(response.headers.get("x-ratelimit-reset"));
	if (Number.isFinite(remaining)) ctx.pace?.("minute", { operation, remaining, resetAt: Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : null });
}

function failure(response, operation) {
	const retryAfter = Number(response.headers.get("retry-after"));
	if (response.status === 401) return new DiscoveryAuthError(`TinyFish ${operation} refused the key (401)`);
	if (response.status === 402) return new DiscoveryLimitError(`TinyFish ${operation}'s free daily allowance is used up (402)`, { scope: "day" });
	if (response.status === 429) return new DiscoveryLimitError(`TinyFish ${operation} answered 429`, { scope: "minute", retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : 60_000 });
	return new DiscoveryError(`TinyFish ${operation} answered ${response.status}`);
}

const tinyfish = {
	id: "tinyfish",
	needsKey: true,
	limits: { minute: 30, hour: 500 },
	fetchLimits: { minute: 150, day: 1000 },
	perQuery: true,
	supports: { site: true, since: true, language: true, fetch: true },
	async search({ query, site, since, language, max = 10 }, ctx) {
		const params = new URLSearchParams({ query, domain_type: "news" });
		if (site) params.set("include_domains", site);
		if (language) params.set("language", language);
		if (since) params.set("after_date", new Date(since).toISOString().slice(0, 10));
		const response = await ctx.fetchImpl(`${SEARCH}?${params}`, { headers: { accept: "application/json", "x-api-key": ctx.key.secret } });
		report(response, ctx, "search");
		if (response.status !== 200) throw failure(response, "search");
		const body = parseJson(response.text, "TinyFish search");
		const results = (body?.results ?? []).slice(0, max).map((item) => result({ url: item.url, title: item.title, snippet: item.snippet, publishedAt: item.date, publisher: item.publisher || item.site_name }));
		return { results, usage: { requests: 1, costUsd: 0 } };
	},
	async fetch({ url }, ctx) {
		const response = await ctx.fetchImpl(FETCH, {
			method: "POST",
			headers: { accept: "application/json", "content-type": "application/json", "x-api-key": ctx.key.secret },
			body: JSON.stringify({ urls: [url], format: "markdown", links: true }),
			timeoutMs: 60_000,
		});
		report(response, ctx, "fetch");
		if (response.status !== 200) throw failure(response, "fetch");
		const body = parseJson(response.text, "TinyFish fetch");
		const page = body?.results?.[0];
		if (!page) {
			const problem = body?.errors?.[0];
			return { url, finalUrl: url, status: problem?.status ?? 0, text: "", refused: UNREADABLE.has(problem?.error), problem: problem?.error ?? "no result", usage: { requests: 1, costUsd: 0 } };
		}
		return { url, finalUrl: page.final_url || url, status: 200, title: page.title ?? "", text: typeof page.text === "string" ? page.text : "", links: Array.isArray(page.links) ? page.links : [], usage: { requests: 1, costUsd: 0 } };
	},
};

export default tinyfish;
