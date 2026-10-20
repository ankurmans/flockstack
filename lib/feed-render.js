import { escapeText } from "./editor-blocks.js";

// A feed's items as the plain content an issue is made of (headings, links, pictures, paragraphs), so what a feed block
// turns into can be edited in the editor like anything a writer typed, and the cleaner, the email and the web page treat
// it like the rest.

function byNewest(a, b) {
	return new Date(b.publishedAt) - new Date(a.publishedAt);
}

// Items newest first: the dated ones by date, then the undated in the order the feed lists them.
export function sortFeedItems(items) {
	const dated = items.filter((item) => item.publishedAt).sort(byNewest);
	return [...dated, ...items.filter((item) => !item.publishedAt)];
}

// The `count` newest items, then in the block's order. since: only items newer than that moment; seenIds: undated
// items are new when they aren't among these.
export function selectFeedItems(items, { count, order = "newest" }, { since = null, seenIds = null } = {}) {
	const seen = new Set(seenIds ?? []);
	const fresh = sortFeedItems(items).filter((item) => {
		if (!since && !seenIds) return true;
		return item.publishedAt ? !since || new Date(item.publishedAt) > new Date(since) : !seen.has(item.id);
	});
	const chosen = fresh.slice(0, count);
	return order === "oldest" ? chosen.reverse() : chosen;
}

export function formatFeedDate(value) {
	return new Date(value).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

export function renderFeedItems(items, { image = true, excerpt = true, date = true, excerptLength = 280 } = {}) {
	return items
		.map((item) => {
			const title = escapeText(item.title);
			const heading = item.link ? `<a href="${escapeText(item.link)}">${title}</a>` : title;
			const text = excerpt && item.excerpt ? (item.excerpt.length > excerptLength ? `${item.excerpt.slice(0, excerptLength - 1).trimEnd()}…` : item.excerpt) : "";
			return [
				image && item.image ? `<img src="${escapeText(item.image)}" alt="${title}">` : "",
				`<h3>${heading}</h3>`,
				date && item.publishedAt ? `<p><small>${formatFeedDate(item.publishedAt)}</small></p>` : "",
				text ? `<p>${escapeText(text)}</p>` : "",
			].join("");
		})
		.join("<hr>");
}
