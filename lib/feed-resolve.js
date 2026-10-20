import "server-only";
import { findFeedBlocks } from "@/lib/editor-blocks";
import { fetchFeed } from "@/lib/feed-fetch";
import { renderFeedItems, selectFeedItems } from "@/lib/feed-render";

export function hasFeedBlocks(html) {
	return /\sdata-rss\s*=/i.test(String(html ?? ""));
}

// An issue's feed blocks turned into the items they stand for, as plain content (lib/feed-render.js). since and seenIds
// keep a block to what is new (a series). Answers { html, items }: items are the ones shown, in reading order. A feed
// that can't be read throws, so an issue never goes out with a hole where it should be; a block whose feed has nothing
// new becomes nothing.
export async function resolveFeedBlocks(html, { account, since = null, seenIds = null } = {}) {
	const source = String(html ?? "");
	const blocks = findFeedBlocks(source);
	if (blocks.length === 0) return { html: source, items: [] };
	const urls = [...new Set(blocks.flatMap(({ options }) => (options ? [options.url] : [])))];
	const feeds = new Map(await Promise.all(urls.map(async (url) => [url, await fetchFeed({ account, url })])));
	const shown = [];
	const replacements = [];
	for (const { start, end, options } of blocks) {
		if (!options) {
			replacements.push({ start, end, content: "" });
			continue;
		}
		const { items } = feeds.get(options.url);
		const chosen = selectFeedItems(items, options, { since, seenIds });
		shown.push(...chosen);
		replacements.push({ start, end, content: renderFeedItems(chosen, options) });
	}
	let result = source;
	for (const { start, end, content } of replacements.reverse()) result = result.slice(0, start) + content + result.slice(end);
	return { html: result, items: shown };
}
