import "server-only";
import { scoped } from "@/lib/account-scope";
import { codedError } from "@/lib/account-state";
import { getFeedUrlProblem } from "@/lib/feed-url";
import { isFeed, parseFeed } from "@/lib/feed-parse";
import FeedCache from "@/models/FeedCache";

// How a feed is read for an issue. A fetch is the only way a customer's input makes FlockStack open a connection to a
// host of their choosing, so it is https to a public name or address, redirects are followed by hand and checked like the
// first address, the answer is cut at a size and the wait at a time, and the result is kept for a few minutes.
export const FEED_LIMITS = { bytes: 1_000_000, timeoutMs: 8000, redirects: 3, cacheMs: 5 * 60_000, staleMs: 60 * 60_000 };

const ACCEPT = "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1";

function feedError(message) {
	return codedError({ code: "validation_failed", message });
}

async function readBody(response) {
	const length = Number(response.headers.get("content-length"));
	if (length > FEED_LIMITS.bytes) throw feedError("The feed is too large: it can be 1 MB at most");
	const reader = response.body?.getReader();
	if (!reader) return "";
	const chunks = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > FEED_LIMITS.bytes) {
			await reader.cancel();
			throw feedError("The feed is too large: it can be 1 MB at most");
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	const charset = /charset=["']?([\w-]+)/i.exec(response.headers.get("content-type") ?? "")?.[1];
	try {
		return new TextDecoder(charset || "utf-8").decode(bytes);
	} catch {
		return new TextDecoder().decode(bytes);
	}
}

// The feed's text and its final address. Each address along the way passes the same check.
async function download(link) {
	let url = link;
	for (let hops = 0; hops <= FEED_LIMITS.redirects; hops += 1) {
		const problem = getFeedUrlProblem(url);
		if (problem) throw feedError(hops === 0 ? problem : `The feed redirects to an address FlockStack can't read: ${problem}`);
		let response;
		try {
			response = await fetch(url, {
				redirect: "manual",
				headers: { accept: ACCEPT, "user-agent": "FlockStack (+https://flockstack.io)" },
				signal: AbortSignal.timeout(FEED_LIMITS.timeoutMs),
			});
		} catch (error) {
			throw feedError(error?.name === "TimeoutError" ? "The feed took too long to answer" : "The feed's server could not be reached");
		}
		const location = response.headers.get("location");
		if (response.status >= 300 && response.status < 400 && location) {
			await response.body?.cancel();
			url = new URL(location, url).href;
			continue;
		}
		if (response.status !== 200) {
			await response.body?.cancel();
			throw feedError(`The feed answered ${response.status}`);
		}
		return { text: await readBody(response), url };
	}
	throw feedError("The feed redirects too many times");
}

// { title, items, fetchedAt, cached }: items newest first as the feed lists them, up to 50. A feed that can't be read
// answers with the copy kept in the last hour, when there is one.
export async function fetchFeed({ account, url, now = Date.now() }) {
	const problem = getFeedUrlProblem(url);
	if (problem) throw feedError(problem);
	const key = new URL(url.trim()).href;
	const kept = await FeedCache.findOne(scoped(account, { key })).lean();
	const age = kept ? now - new Date(kept.fetchedAt).getTime() : Infinity;
	if (age < FEED_LIMITS.cacheMs) return { title: kept.title ?? "", items: kept.items, fetchedAt: kept.fetchedAt, cached: true };
	try {
		const { text, url: finalUrl } = await download(key);
		if (!isFeed(text)) throw feedError("That address isn't an RSS or Atom feed");
		const { title, items } = parseFeed(text, finalUrl);
		const fetchedAt = new Date(now);
		await FeedCache.updateOne(scoped(account, { key }), { $set: { title, items, fetchedAt } }, { upsert: true });
		return { title, items, fetchedAt, cached: false };
	} catch (error) {
		if (kept && age < FEED_LIMITS.staleMs) return { title: kept.title ?? "", items: kept.items, fetchedAt: kept.fetchedAt, cached: true, stale: true };
		throw error;
	}
}

// Copies nobody used for a day, for the hourly job.
export async function purgeOldFeeds(now = Date.now()) {
	const cutoff = new Date(now - 24 * 60 * 60_000);
	return (await FeedCache.deleteMany({ fetchedAt: { $lt: cutoff } }).setOptions({ crossAccount: true })).deletedCount ?? 0;
}
