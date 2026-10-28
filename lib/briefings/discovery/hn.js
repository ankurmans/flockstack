import { DiscoveryError, DiscoveryLimitError, parseJson, result } from "./errors.js";

// Hacker News through Algolia (hn.algolia.com/api/v1/search_by_date). The only published rule is 10,000 requests an hour per IP,
// and Workers share outbound addresses, so the engine makes one request per query at most. A story without its own link is the
// discussion itself, labelled community.
const ENDPOINT = "https://hn.algolia.com/api/v1/search_by_date";

const hackerNews = {
	id: "hn",
	needsKey: false,
	limits: { hour: 10_000 },
	perQuery: true,
	supports: { site: false, since: true, language: false, fetch: false },
	async search({ query, since, max = 10 }, ctx) {
		const params = new URLSearchParams({ query, tags: "story", hitsPerPage: String(Math.min(50, max)) });
		if (since) params.set("numericFilters", `created_at_i>${Math.floor(new Date(since).getTime() / 1000)}`);
		const response = await ctx.fetchImpl(`${ENDPOINT}?${params}`, { headers: { accept: "application/json" } });
		if (response.status === 429) throw new DiscoveryLimitError("Hacker News search answered 429", { scope: "hour" });
		if (response.status !== 200) throw new DiscoveryError(`Hacker News search answered ${response.status}`);
		const body = parseJson(response.text, "Hacker News search");
		const results = (body?.hits ?? []).slice(0, max).map((hit) => {
			const discussion = `https://news.ycombinator.com/item?id=${encodeURIComponent(hit.objectID)}`;
			return result({ url: hit.url || discussion, title: hit.title, snippet: hit.story_text ?? "", publishedAt: hit.created_at, publisher: hit.url ? "" : "news.ycombinator.com" });
		});
		return { results, usage: { requests: 1, costUsd: 0 } };
	},
};

export default hackerNews;
