import "server-only";
import * as z from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { dateOutput, toIso } from "@/lib/actions/shared";
import { FEED_BLOCK } from "@/lib/editor-blocks";
import { fetchFeed } from "@/lib/feed-fetch";
import { selectFeedItems } from "@/lib/feed-render";
import { MAX_FEED_URL_LENGTH } from "@/lib/feed-url";

const GROUP = "Feeds";

export const FeedItemSchema = z.object({
	title: z.string(),
	link: z.string().nullable(),
	publishedAt: dateOutput.describe("When the feed says it was published; null when it doesn't say"),
	excerpt: z.string().describe("The start of its summary as plain text, 600 characters at most"),
	image: z.string().nullable().describe("Its picture: the feed's thumbnail, enclosure or the first image in its text"),
});

export const feedUrlInput = z.string().trim().min(1).max(MAX_FEED_URL_LENGTH).describe("The feed's address: an https:// link to an RSS or Atom feed on a public host");

export function toFeedItem(item) {
	return { title: item.title, link: item.link ?? null, publishedAt: toIso(item.publishedAt), excerpt: item.excerpt ?? "", image: item.image ?? null };
}

const previewFeed = defineAction({
	name: "preview_feed",
	tryWithoutPlan: true,
	title: "Preview an RSS feed",
	group: GROUP,
	description: `Reads an RSS or Atom feed and answers its latest items, as an RSS block would show them in an issue. Put the block in a rich campaign's content as <div data-rss="https://example.com/feed.xml" data-count="3" data-order="newest" data-image="1" data-excerpt="1" data-date="1"></div> (count ${FEED_BLOCK.defaultCount} by default, ${FEED_BLOCK.maxCount} at most; order newest or oldest; each of image, excerpt and date 1 or 0): the feed is read when the campaign is sent, or sent as a test, and the block becomes the items. A feed that can't be read stops the send. Feeds are read over https only, from public hosts, up to 1 MB and 8 seconds, and kept for 5 minutes.`,
	http: { method: "GET", path: "/feeds/preview" },
	readOnly: true,
	openWorld: true,
	rateLimit: { limit: 60, window: "1 h" },
	limitDashboard: true,
	example: { url: "https://example.com/feed.xml", count: 3 },
	input: z.object({
		url: feedUrlInput,
		count: z.number().int().min(1).max(FEED_BLOCK.maxCount).optional().describe(`How many items, ${FEED_BLOCK.defaultCount} by default`),
		order: z.enum(["newest", "oldest"]).optional().describe("newest first (the default) or oldest first, of the newest items"),
	}),
	output: z.object({
		title: z.string().describe("The feed's title"),
		items: z.array(FeedItemSchema),
		fetchedAt: dateOutput.describe("When FlockStack last read the feed; up to 5 minutes ago"),
	}),
	handler: async ({ account, input }) => {
		const feed = await fetchFeed({ account, url: input.url });
		const items = selectFeedItems(feed.items, { count: input.count ?? FEED_BLOCK.defaultCount, order: input.order });
		return { title: feed.title, items: items.map(toFeedItem), fetchedAt: toIso(feed.fetchedAt) };
	},
});

export const feedActions = [previewFeed];
