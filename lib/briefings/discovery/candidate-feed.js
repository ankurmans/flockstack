import { DiscoveryAuthError, DiscoveryError, DiscoveryLimitError, parseJson, result } from "./errors.js";

// Any https JSON list of candidates behind a bearer key: { items: [{ url, title, snippet, publishedAt, publisher }] }. Read once a
// run. Owner-only community signals (Sniffington's Reddit and Bluesky finds) plug in this way; none of their code is here.
const candidateFeed = {
	id: "candidate-feed",
	needsKey: true,
	limits: { minute: 10 },
	perQuery: false,
	supports: { site: false, since: true, language: false, fetch: false },
	async search({ since, max = 100 }, ctx) {
		const address = new URL(ctx.key.baseUrl);
		if (since) address.searchParams.set("since", new Date(since).toISOString());
		const response = await ctx.fetchImpl(address.href, { headers: { accept: "application/json", authorization: `Bearer ${ctx.key.secret}` } });
		if (response.status === 401 || response.status === 403) throw new DiscoveryAuthError(`The candidate feed refused the key (${response.status})`);
		if (response.status === 429) throw new DiscoveryLimitError("The candidate feed answered 429", { scope: "minute" });
		if (response.status !== 200) throw new DiscoveryError(`The candidate feed answered ${response.status}`);
		const body = parseJson(response.text, "The candidate feed");
		if (!Array.isArray(body?.items)) throw new DiscoveryError("The candidate feed has no items list");
		return { results: body.items.slice(0, max).map(result), usage: { requests: 1, costUsd: 0 } };
	},
};

export default candidateFeed;
