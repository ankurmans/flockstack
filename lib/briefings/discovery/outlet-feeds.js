import { isFeed, parseFeed } from "../../feed-parse.js";
import { DiscoveryError, result } from "./errors.js";

// The feeds of the briefing's trusted outlets and of publishers that earned a score. A host without a known feed has its home
// page read once for <link rel="alternate"> (feed autodiscovery); what was found, or "" for none, comes back in `feeds` for the
// engine to keep on BriefingPublisher, so the home page isn't read again. Every page goes through the engine's own fetcher
// (robots.txt, blocked hosts, public addresses).
const FEED_ACCEPT = "application/rss+xml, application/atom+xml, application/feed+json, application/json;q=0.9, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1";
const FEED_TYPES = /application\/(?:rss\+xml|atom\+xml|feed\+json)/i;

export function findFeedLink(html, base) {
	for (const tag of String(html ?? "").matchAll(/<link\b[^>]*>/gi)) {
		const text = tag[0];
		if (!/rel\s*=\s*["']?[^"'>]*alternate/i.test(text) || !FEED_TYPES.test(text)) continue;
		const href = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(text);
		try {
			const url = new URL((href?.[1] ?? href?.[2] ?? href?.[3] ?? "").trim(), base);
			if (url.protocol === "https:") return url.href;
		} catch {
			// The next link may do.
		}
	}
	return null;
}

function jsonFeedItems(text, base) {
	let feed;
	try {
		feed = JSON.parse(text);
	} catch {
		return null;
	}
	if (!Array.isArray(feed?.items)) return null;
	return feed.items.map((item) => {
		let link = null;
		try {
			link = new URL(item.url ?? item.external_url ?? "", base).href;
		} catch {
			link = null;
		}
		return { link, title: item.title, excerpt: item.summary ?? item.content_text ?? "", publishedAt: item.date_published ?? item.date_modified ?? null };
	});
}

const outletFeeds = {
	id: "outlet-feeds",
	needsKey: false,
	limits: {},
	perQuery: false,
	supports: { site: false, since: true, language: false, fetch: false },
	async search({ since, max = 25 }, ctx) {
		const results = [];
		const feeds = {};
		const problems = [];
		for (const { host, feedUrl } of ctx.outlets ?? []) {
			let feed = feedUrl;
			try {
				if (feed === undefined || feed === null) {
					const home = await ctx.fetchPage(`https://${host}/`);
					feed = findFeedLink(home.text, home.url) ?? "";
					feeds[host] = feed;
				}
				if (!feed) continue;
				const page = await ctx.fetchPage(feed, { accept: FEED_ACCEPT });
				const entries = isFeed(page.text) ? parseFeed(page.text, page.url).items : jsonFeedItems(page.text, page.url);
				if (!entries) throw new DiscoveryError("isn't a feed");
				const cutoff = since ? new Date(since).getTime() : -Infinity;
				results.push(
					...entries
						.filter((entry) => entry.link && (!entry.publishedAt || new Date(entry.publishedAt).getTime() >= cutoff))
						.slice(0, max)
						.map((entry) => result({ url: entry.link, title: entry.title, snippet: entry.excerpt, publishedAt: entry.publishedAt, publisher: host }))
				);
			} catch (error) {
				problems.push({ host, problem: String(error?.message ?? error).slice(0, 160) });
			}
		}
		return { results, feeds, problems, usage: { requests: 0, costUsd: 0 } };
	},
};

export default outletFeeds;
