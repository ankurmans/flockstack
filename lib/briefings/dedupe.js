import { canonicalUrl, sha256Hex } from "./urls.js";

// Dedupe (docs/BRIEFINGS-DESIGN.md, The run, 2): what discovery found becomes the run's items, one per canonical address,
// leaving out what BriefingSeen already has and what was published before the previous run (a first run looks back a week).
export const DEDUPE = { maxItems: 200, firstRunLookbackMs: 7 * 24 * 60 * 60_000 };

function toIso(value) {
	if (!value) return null;
	const date = new Date(value);
	return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

// Discovery's { url, title, snippet, publishedAt, publisher, foundBy } as an item, or null for an address that isn't a web page.
export async function toItem(found) {
	const url = canonicalUrl(found?.url);
	if (!url) return null;
	return {
		url,
		title: String(found.title || url).replace(/\s+/g, " ").trim().slice(0, 300),
		excerpt: String(found.snippet ?? "").replace(/\s+/g, " ").trim().slice(0, 600),
		publishedAt: toIso(found.publishedAt),
		publisher: String(found.publisher ?? "").slice(0, 120),
		foundBy: String(found.foundBy ?? "").slice(0, 120),
		weight: Number.isFinite(found.weight) ? found.weight : 1,
		urlHash: await sha256Hex(url),
	};
}

// seen(hashes) -> Set of the hashes BriefingSeen has for the briefing. Newest first, at most DEDUPE.maxItems.
export async function dedupeItems({ items, seen, since }) {
	const unique = new Map();
	for (const item of items) if (item && !unique.has(item.urlHash)) unique.set(item.urlHash, item);
	const known = await seen([...unique.keys()]);
	const cutoff = since ? new Date(since).getTime() : -Infinity;
	return [...unique.values()]
		.filter((item) => !known.has(item.urlHash))
		.filter((item) => !item.publishedAt || new Date(item.publishedAt).getTime() >= cutoff)
		.sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))
		.slice(0, DEDUPE.maxItems);
}
