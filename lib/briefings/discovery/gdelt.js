import { DiscoveryError, DiscoveryLimitError, parseJson, result } from "./errors.js";

// The GDELT DOC 2.0 API, article list mode (api.gdeltproject.org/api/v2/doc/doc). Free, no key; any use must credit the GDELT
// Project and link to gdeltproject.org, which the owner's run page does. GDELT answers a request sooner than five seconds after
// the last with a plain-text "Please limit requests to one every 5 seconds", so the engine spaces them that far apart.
const ENDPOINT = "https://api.gdeltproject.org/api/v2/doc/doc";
const MAX_RECORDS = 250;

// "20261028T091500Z" -> an ISO time.
export function parseSeenDate(value) {
	const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(String(value ?? ""));
	return match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z` : null;
}

function stamp(date) {
	return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "");
}

const gdelt = {
	id: "gdelt",
	needsKey: false,
	limits: { minute: 12 },
	minIntervalMs: 5000,
	perQuery: true,
	supports: { site: true, since: true, language: true, fetch: false },
	async search({ query, site, since, language, max = 10 }, ctx) {
		const terms = [/\s/.test(query.trim()) && !/["()]/.test(query) ? `"${query.trim()}"` : query.trim()];
		if (site) terms.push(`domain:${site}`);
		if (language) terms.push(`sourcelang:${language}`);
		const params = new URLSearchParams({ query: terms.join(" "), mode: "artlist", format: "json", maxrecords: String(Math.min(MAX_RECORDS, max)), sort: "datedesc" });
		const start = since ? new Date(Math.max(new Date(since).getTime(), ctx.now.getTime() - 90 * 24 * 60 * 60_000)) : new Date(ctx.now.getTime() - 24 * 60 * 60_000);
		params.set("startdatetime", stamp(start));
		params.set("enddatetime", stamp(ctx.now));
		const response = await ctx.fetchImpl(`${ENDPOINT}?${params}`, { headers: { accept: "application/json" } });
		if (/limit requests to one every/i.test(response.text)) throw new DiscoveryLimitError("GDELT asked for one request every 5 seconds", { scope: "minute", retryAfterMs: 5000 });
		if (response.status === 429) throw new DiscoveryLimitError("GDELT answered 429", { scope: "minute", retryAfterMs: 5000 });
		if (response.status !== 200) throw new DiscoveryError(`GDELT answered ${response.status}`);
		if (!response.text.trim()) return { results: [], usage: { requests: 1, costUsd: 0 } };
		const body = parseJson(response.text, "GDELT");
		const results = (body?.articles ?? []).slice(0, max).map((article) => result({ url: article.url, title: article.title, publishedAt: parseSeenDate(article.seendate), publisher: article.domain }));
		return { results, usage: { requests: 1, costUsd: 0 } };
	},
};

export default gdelt;
