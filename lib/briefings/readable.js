import { decodeEntities } from "../editor-blocks.js";

// A page as the engine reads it: its title, its readable text and its links, from HTML without a parser (Workers have none).
// Page text is untrusted: nothing here runs or follows anything, and what comes out is only ever handed to a model as data.
export const MAX_READABLE_CHARS = 20_000;

const DROPPED = ["script", "style", "noscript", "svg", "template", "iframe", "nav", "header", "footer", "aside", "form", "button", "select"];
const BLOCK_END = /<\/(?:p|div|section|article|li|ul|ol|h[1-6]|tr|table|blockquote|pre|figure|figcaption|dd|dt)\s*>|<br\s*\/?>/gi;

function dropElements(html, names) {
	let text = html.replace(/<!--[\s\S]*?-->/g, " ");
	for (const name of names) text = text.replace(new RegExp(`<${name}\\b[\\s\\S]*?</${name}\\s*>`, "gi"), " ");
	return text;
}

function innerOf(html, name) {
	const start = new RegExp(`<${name}\\b[^>]*>`, "i").exec(html);
	if (!start) return null;
	const end = html.toLowerCase().lastIndexOf(`</${name}`);
	return end > start.index ? html.slice(start.index + start[0].length, end) : null;
}

function attribute(tag, name) {
	const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
	return match ? decodeEntities(match[1] ?? match[2] ?? match[3] ?? "").trim() : null;
}

function toText(html) {
	return decodeEntities(html.replace(BLOCK_END, "\n").replace(/<[^>]*>/g, " "))
		.split("\n")
		.map((line) => line.replace(/[ \t\f\v ]+/g, " ").trim())
		.filter(Boolean)
		.join("\n");
}

function readLinks(html, base) {
	const links = [];
	for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
		const href = attribute(match[1], "href");
		if (!href || href.startsWith("#") || /^(?:mailto|tel|javascript|data):/i.test(href)) continue;
		let url;
		try {
			url = new URL(href, base);
		} catch {
			continue;
		}
		if (url.protocol !== "https:" && url.protocol !== "http:") continue;
		const text = toText(match[2]).replace(/\s+/g, " ").slice(0, 300);
		links.push({ url: url.href, text });
	}
	return links;
}

// The page's og:image as an absolute https address, or null: kept only as the story's link preview on the owner's pages
// (models/BriefingRun.js previewImage), never put in an issue.
export function previewImageOf(head, base) {
	const tag = /<meta\b[^>]*property\s*=\s*["']og:image["'][^>]*>/i.exec(head)?.[0];
	const value = tag && attribute(tag, "content");
	if (!value) return null;
	try {
		const url = new URL(value, base);
		return url.protocol === "https:" && url.href.length <= 1000 && !/[\s"'<>]/.test(url.href) ? url.href : null;
	} catch {
		return null;
	}
}

// { title, text, links, canonical, publishedAt, image }. The text is the page's <article> or <main> when it has one, with menus,
// headers, footers, forms and scripts left out, cut at MAX_READABLE_CHARS.
export function readablePage(html, base) {
	const source = String(html ?? "");
	const head = innerOf(source, "head") ?? source.slice(0, 20_000);
	const ogTitle = /<meta\b[^>]*property\s*=\s*["']og:title["'][^>]*>/i.exec(head)?.[0];
	const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head)?.[1];
	const title = toText((ogTitle && attribute(ogTitle, "content")) || titleTag || "").replace(/\s+/g, " ").slice(0, 300);
	const canonicalTag = /<link\b[^>]*rel\s*=\s*["']canonical["'][^>]*>/i.exec(head)?.[0];
	const publishedTag = /<meta\b[^>]*(?:property|name)\s*=\s*["'](?:article:published_time|date|pubdate)["'][^>]*>/i.exec(head)?.[0];
	const published = publishedTag ? new Date(attribute(publishedTag, "content") ?? "") : null;
	const body = dropElements(innerOf(source, "body") ?? source, DROPPED);
	const main = innerOf(body, "article") ?? innerOf(body, "main") ?? body;
	let canonical = null;
	try {
		canonical = canonicalTag && attribute(canonicalTag, "href") ? new URL(attribute(canonicalTag, "href"), base).href : null;
	} catch {
		canonical = null;
	}
	return {
		title,
		text: toText(main).slice(0, MAX_READABLE_CHARS),
		links: readLinks(main, base),
		allLinks: readLinks(dropElements(innerOf(source, "body") ?? source, ["script", "style", "noscript", "svg", "template"]), base),
		canonical,
		publishedAt: published && Number.isFinite(published.getTime()) ? published.toISOString() : null,
		image: previewImageOf(head, base),
	};
}
