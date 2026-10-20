import { decodeEntities } from "./editor-blocks.js";

// RSS 2.0, RSS 1.0 (RDF) and Atom feeds as a list of items, read without an XML parser (Workers have none): a feed is
// untrusted text, so nothing here expands entities beyond the five XML ones and numbers, follows a DOCTYPE or
// evaluates anything. A malformed feed gives the items that could be read.
export const MAX_FEED_ITEMS = 50;
const EXCERPT_LIMIT = 600;
const TITLE_LIMIT = 300;
const MAX_URL_LENGTH = 1000;
const ITEM_NAMES = ["item", "entry"];

function escapeName(name) {
	return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The inner text of the first <name>…</name> (a prefix like dc: counts as part of the name), CDATA unwrapped.
function readTag(block, name) {
	const match = new RegExp(`<${escapeName(name)}(?:\\s[^>]*)?>([\\s\\S]*?)</${escapeName(name)}\\s*>`, "i").exec(block);
	return match ? unwrap(match[1]) : null;
}

function unwrap(value) {
	const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(value);
	return cdata ? cdata[1] : decodeEntities(value);
}

// Start tags of that name: the attributes of each, for <link href>, <enclosure url>, <media:thumbnail url>.
function readStartTags(block, name) {
	return [...block.matchAll(new RegExp(`<${escapeName(name)}(\\s[^>]*?)?/?>`, "gi"))].map((match) => match[1] ?? "");
}

function readAttribute(attributes, name) {
	const match = new RegExp(`(?:^|\\s)${escapeName(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(attributes);
	return match ? decodeEntities(match[1] ?? match[2] ?? "") : null;
}

function toWebUrl(value, base) {
	const text = String(value ?? "").trim();
	if (!text || text.length > MAX_URL_LENGTH) return null;
	try {
		const url = new URL(text, base);
		return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
	} catch {
		return null;
	}
}

function toDate(value) {
	if (!value) return null;
	const date = new Date(value.trim());
	return Number.isFinite(date.getTime()) ? date : null;
}

function readLink(block, base) {
	const atom = readStartTags(block, "link");
	const alternate = atom.find((attributes) => readAttribute(attributes, "href") && ["alternate", null].includes(readAttribute(attributes, "rel")));
	if (alternate) return toWebUrl(readAttribute(alternate, "href"), base);
	const text = readTag(block, "link");
	return toWebUrl(text, base) ?? toWebUrl(readTag(block, "guid"), base);
}

function isImageType(attributes) {
	const type = readAttribute(attributes, "type") ?? "";
	const medium = readAttribute(attributes, "medium") ?? "";
	return type.startsWith("image/") || medium === "image" || /\.(?:jpe?g|png|gif|webp|avif)(?:$|\?)/i.test(readAttribute(attributes, "url") ?? "");
}

function readImage(block, body, base) {
	const candidates = [
		...readStartTags(block, "media:thumbnail"),
		...readStartTags(block, "media:content").filter(isImageType),
		...readStartTags(block, "enclosure").filter(isImageType),
	];
	for (const attributes of candidates) {
		const url = toWebUrl(readAttribute(attributes, "url"), base);
		if (url) return url;
	}
	const inline = /<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(body);
	return inline ? toWebUrl(decodeEntities(inline[1] ?? inline[2]), base) : null;
}

// Text of a summary that may hold markup: tags go, and the ends of paragraphs and lines become spaces.
function textOf(html) {
	return decodeEntities(
		String(html ?? "")
			.replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, " ")
			.replace(/<[^>]*>/g, "")
	)
		.replace(/\s+/g, " ")
		.trim();
}

function clip(text, limit) {
	return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

function readItem(block, base) {
	const title = clip(textOf(readTag(block, "title") ?? ""), TITLE_LIMIT);
	const link = readLink(block, base);
	if (!title && !link) return null;
	// The summary may hold markup (RSS puts HTML in description, Atom says type="html"): it is read as text.
	const body = readTag(block, "content:encoded") ?? readTag(block, "content") ?? readTag(block, "description") ?? readTag(block, "summary") ?? "";
	const summary = readTag(block, "description") ?? readTag(block, "summary") ?? body;
	const publishedAt = toDate(readTag(block, "pubDate") ?? readTag(block, "published") ?? readTag(block, "dc:date") ?? readTag(block, "updated"));
	return {
		id: String(readTag(block, "guid") ?? readTag(block, "id") ?? link ?? title).trim().slice(0, 500),
		title: title || link,
		link,
		publishedAt: publishedAt ? publishedAt.toISOString() : null,
		excerpt: clip(textOf(summary), EXCERPT_LIMIT),
		image: readImage(block, body, base),
	};
}

// The blocks of each <item> or <entry>, found by scanning for the start and end tags: a feed with thousands of items is
// read up to the cap and no further.
function splitItems(xml) {
	const blocks = [];
	const lower = xml.toLowerCase();
	const pattern = new RegExp(`<(${ITEM_NAMES.join("|")})(?:\\s[^>]*)?>`, "gi");
	for (const start of xml.matchAll(pattern)) {
		if (start.index < (blocks.at(-1)?.end ?? 0)) continue;
		const end = lower.indexOf(`</${start[1].toLowerCase()}>`, start.index);
		if (end === -1) break;
		blocks.push({ text: xml.slice(start.index + start[0].length, end), end });
		if (blocks.length >= MAX_FEED_ITEMS) break;
	}
	return blocks.map(({ text }) => text);
}

// { title, items } with the items in the order the feed lists them (newest first, as feeds are written). base: the
// feed's own address, for links written as paths.
export function parseFeed(xml, base = "https://example.com/") {
	const text = String(xml ?? "");
	if (!/<(rss|feed|rdf:RDF)\b/i.test(text)) return { title: "", items: [] };
	const firstItem = text.search(new RegExp(`<(${ITEM_NAMES.join("|")})(?:\\s|>)`, "i"));
	const header = firstItem === -1 ? text : text.slice(0, firstItem);
	const items = splitItems(text).map((block) => readItem(block, base)).filter(Boolean);
	return { title: clip(textOf(readTag(header, "title") ?? ""), TITLE_LIMIT), items };
}

export function isFeed(xml) {
	return /<(rss|feed|rdf:RDF)\b/i.test(String(xml ?? ""));
}
