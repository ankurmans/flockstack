import Papa from "papaparse";
import { SOURCE_NAMES } from "./post-import-report.js";
import { slugify } from "./slug.js";
import { isZip, readZipFiles } from "./unzip.js";

// The archives other platforms export, read into one shape: { sourceId, title, subtitle, html, publishedAt, slug, oldPath,
// author, paid, thumbnailUrl }, newest first. Only published posts come; drafts, pages and podcasts are counted in skipped.
// Each platform's format is what its export gives today:
// - Substack: a ZIP with posts.csv (post_id "123.slug", post_date, is_published, type, audience, title, subtitle) and
//   posts/<post_id>.html with each post's body. Its pages live at /p/<slug>.
// - beehiiv: one CSV (id, web_title, status, audience or web_audiences, url, web_subtitle, email_subject_line,
//   email_preview_text, content_html, thumbnail_url, created_at), the email's HTML. Pages at /p/<slug>.
// - WordPress: the WXR file of Tools > Export, RSS with wp: elements. Pages at their permalink.
// - Ghost: the JSON of Settings > Labs > Export, posts with their HTML, authors through posts_authors. Pages at /<slug>/.
export const POST_SOURCES = ["substack", "beehiiv", "wordpress", "ghost"];
// What a ZIP may expand to: an export's text is a fraction of this.
export const MAX_EXPANDED_BYTES = 120 * 1024 * 1024;
const MAX_TITLE = 200;
const MAX_SUBTITLE = 300;
// beehiiv keeps its pictures under uploads/ on its CDN; its CSV leaves the host out.
const BEEHIIV_MEDIA = "https://media.beehiiv.com/cdn-cgi/image/quality=100/";
const BEEHIIV_PAID = new Set(["premium", "All premium subscribers", "All paid subscribers"]);
const SUBSTACK_PAID = new Set(["only_paid", "founding"]);
const GHOST_PAID = new Set(["paid", "tiers"]);
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function formatError(message) {
	return Object.assign(new Error(message), { code: "validation_failed" });
}

export function decodeEntities(text) {
	return String(text ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name) => {
		if (name[0] === "#") {
			const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
		}
		return ENTITIES[name.toLowerCase()] ?? match;
	});
}

function plainText(value, max) {
	return decodeEntities(String(value ?? "").replace(/<[^>]*>/g, " "))
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, max);
}

// Dates without a zone (beehiiv's "2023-01-18 21:25:27", WordPress's _gmt fields) are UTC.
export function parseDate(value) {
	const text = String(value ?? "").trim();
	if (!text || text.startsWith("0000")) return null;
	const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(text) ? `${text.replace(" ", "T")}Z` : text;
	const date = new Date(iso);
	return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function pathOf(url) {
	try {
		return new URL(url).pathname;
	} catch {
		return null;
	}
}

function toPost({ sourceId, title, subtitle, html, publishedAt, slug, oldPath, author, paid, thumbnailUrl }) {
	const cleanTitle = plainText(title, MAX_TITLE);
	return {
		sourceId: String(sourceId),
		title: cleanTitle || "Untitled",
		subtitle: plainText(subtitle, MAX_SUBTITLE),
		html: String(html ?? ""),
		publishedAt,
		slug: slugify(slug || cleanTitle, 80) || "issue",
		oldPath: oldPath && oldPath !== "/" ? oldPath : null,
		author: plainText(author, 100) || null,
		paid: Boolean(paid),
		thumbnailUrl: thumbnailUrl || null,
	};
}

function readCsv(text) {
	const { data } = Papa.parse(text, { header: true, skipEmptyLines: true, transformHeader: (header) => header.trim().toLowerCase() });
	return data;
}

function emptySkipped() {
	return { drafts: 0, other: 0, missingContent: 0 };
}

function newestFirst(posts) {
	return posts.sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : 0));
}

function parseSubstack(files) {
	const csvName = [...files.keys()].find((name) => name === "posts.csv" || name.endsWith("/posts.csv"));
	const bodies = new Map();
	for (const [name, bytes] of files) {
		const match = /(?:^|\/)posts\/([^/]+)\.html$/.exec(name);
		if (match) bodies.set(match[1], bytes);
	}
	const decoder = new TextDecoder();
	const skipped = emptySkipped();
	const posts = [];
	for (const row of readCsv(decoder.decode(files.get(csvName)))) {
		const postId = String(row.post_id ?? "").trim();
		if (!postId) continue;
		if (String(row.is_published).toLowerCase() !== "true") {
			skipped.drafts += 1;
			continue;
		}
		if (row.type && row.type !== "newsletter") {
			skipped.other += 1;
			continue;
		}
		const body = bodies.get(postId);
		const publishedAt = parseDate(row.post_date) ?? parseDate(row.email_sent_at);
		if (!body || !publishedAt) {
			skipped.missingContent += 1;
			continue;
		}
		const slug = postId.replace(/^\d+\./, "");
		posts.push(
			toPost({
				sourceId: postId.replace(/\..*$/, ""),
				title: row.title || slug,
				subtitle: row.subtitle,
				html: decoder.decode(body),
				publishedAt,
				slug,
				oldPath: `/p/${slug}`,
				paid: SUBSTACK_PAID.has(row.audience),
			})
		);
	}
	return { posts, skipped };
}

function beehiivImage(path) {
	if (!path) return null;
	if (/^https?:\/\//i.test(path)) return path;
	return /^\/?uploads\//.test(path) ? `${BEEHIIV_MEDIA}${path.replace(/^\//, "")}` : null;
}

function parseBeehiiv(text) {
	const skipped = emptySkipped();
	const posts = [];
	for (const row of readCsv(text)) {
		if (!row.id) continue;
		if (row.status !== "confirmed") {
			skipped.drafts += 1;
			continue;
		}
		const publishedAt = parseDate(row.publish_date || row.created_at);
		if (!row.content_html || !publishedAt) {
			skipped.missingContent += 1;
			continue;
		}
		const audience = row.audience || row.web_audiences || "";
		const path = pathOf(row.url);
		posts.push(
			toPost({
				sourceId: row.id,
				title: row.web_title || row.email_subject_line,
				subtitle: row.web_subtitle || row.email_preview_text,
				html: row.content_html,
				publishedAt,
				slug: path?.match(/\/p\/([^/]+)/)?.[1] ?? row.slug,
				oldPath: path,
				author: row.authors || row.author,
				paid: BEEHIIV_PAID.has(audience) || (/premium|paid/i.test(audience) && !/free/i.test(audience)),
				thumbnailUrl: beehiivImage(row.thumbnail_url),
			})
		);
	}
	return { posts, skipped };
}

// An element's text in WXR: CDATA sections as they are, anything else with its entities decoded.
function xmlText(raw) {
	if (raw === undefined) return "";
	return raw
		.split(/(<!\[CDATA\[[\s\S]*?\]\]>)/)
		.map((part) => (part.startsWith("<![CDATA[") ? part.slice(9, -3) : decodeEntities(part)))
		.join("")
		.trim();
}

function xmlField(xml, tag) {
	const escaped = tag.replace(":", "\\:");
	return xmlText(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)</${escaped}>`).exec(xml)?.[1]);
}

// The classic editor stores paragraphs as blank lines, which WordPress turns into <p> as it shows the post.
function wordpressParagraphs(html) {
	const body = html.replace(/\[caption[^\]]*\]([\s\S]*?)\[\/caption\]/gi, "$1");
	if (/<p[\s>]/i.test(body)) return body;
	return body
		.split(/\n\s*\n/)
		.map((part) => part.trim())
		.filter(Boolean)
		.map((part) => (/^<(h\d|ul|ol|blockquote|pre|table|div|figure|hr)\b/i.test(part) ? part : `<p>${part.replace(/\n/g, "<br>")}</p>`))
		.join("\n");
}

function parseWordpress(text) {
	if (!/wordpress\.org\/export/i.test(text)) throw formatError("This XML file isn't a WordPress export (WXR)");
	const authors = new Map();
	for (const [, author] of text.matchAll(/<wp:author>([\s\S]*?)<\/wp:author>/g)) {
		authors.set(xmlField(author, "wp:author_login"), xmlField(author, "wp:author_display_name"));
	}
	const items = [...text.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, item]) => item);
	const attachments = new Map();
	for (const item of items) {
		if (xmlField(item, "wp:post_type") === "attachment") attachments.set(xmlField(item, "wp:post_id"), xmlField(item, "wp:attachment_url"));
	}
	const skipped = emptySkipped();
	const posts = [];
	for (const item of items) {
		const type = xmlField(item, "wp:post_type");
		if (type === "attachment") continue;
		if (type !== "post") {
			skipped.other += 1;
			continue;
		}
		if (xmlField(item, "wp:status") !== "publish") {
			skipped.drafts += 1;
			continue;
		}
		const content = xmlField(item, "content:encoded");
		const publishedAt = parseDate(xmlField(item, "wp:post_date_gmt")) ?? parseDate(xmlField(item, "pubDate"));
		if (!content || !publishedAt) {
			skipped.missingContent += 1;
			continue;
		}
		const thumbnailId = /<wp:meta_key>(?:<!\[CDATA\[)?_thumbnail_id(?:\]\]>)?<\/wp:meta_key>\s*<wp:meta_value>([\s\S]*?)<\/wp:meta_value>/.exec(item)?.[1];
		const creator = xmlField(item, "dc:creator");
		const link = xmlField(item, "link");
		const path = pathOf(link);
		posts.push(
			toPost({
				sourceId: xmlField(item, "wp:post_id"),
				title: xmlField(item, "title"),
				subtitle: xmlField(item, "excerpt:encoded"),
				html: wordpressParagraphs(content),
				publishedAt,
				slug: xmlField(item, "wp:post_name"),
				// Plain permalinks (/?p=123) have no path to redirect from.
				oldPath: path && !new URL(link).search ? path : null,
				author: authors.get(creator) || creator,
				thumbnailUrl: thumbnailId ? attachments.get(xmlText(thumbnailId)) : null,
			})
		);
	}
	return { posts, skipped, siteUrl: xmlField(text.split("<item>")[0], "link") || null };
}

function parseGhost(text) {
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		throw formatError("This JSON file can't be read: export it again from Ghost");
	}
	const data = json?.db?.[0]?.data ?? json?.data;
	if (!Array.isArray(data?.posts)) throw formatError("This JSON file isn't a Ghost export: it has no posts");
	const users = new Map((data.users ?? []).map((user) => [user.id, user.name]));
	const firstAuthor = new Map();
	for (const link of [...(data.posts_authors ?? [])].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))) {
		if (!firstAuthor.has(link.post_id)) firstAuthor.set(link.post_id, users.get(link.author_id));
	}
	const skipped = emptySkipped();
	const posts = [];
	for (const post of data.posts) {
		if (post.type === "page" || post.page === true || post.page === 1) {
			skipped.other += 1;
			continue;
		}
		if (post.status !== "published") {
			skipped.drafts += 1;
			continue;
		}
		const publishedAt = parseDate(post.published_at);
		if (!post.html || !publishedAt) {
			skipped.missingContent += 1;
			continue;
		}
		posts.push(
			toPost({
				sourceId: post.id,
				title: post.title,
				subtitle: post.custom_excerpt,
				html: post.html,
				publishedAt,
				slug: post.slug,
				oldPath: post.slug ? `/${post.slug}/` : null,
				author: firstAuthor.get(post.id) ?? users.get(post.author_id),
				paid: GHOST_PAID.has(post.visibility),
				thumbnailUrl: post.feature_image,
			})
		);
	}
	return { posts, skipped };
}

function stripBom(text) {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function detectText(text) {
	const start = text.trimStart().slice(0, 2000);
	if (start.startsWith("{")) return "ghost";
	if (start.startsWith("<")) return "wordpress";
	const header = start.split(/\r?\n/)[0].toLowerCase();
	if (header.includes("content_html") || header.includes("web_title")) return "beehiiv";
	if (header.includes("post_id") && header.includes("is_published")) return "substack";
	return null;
}

const TEXT_PARSERS = { beehiiv: parseBeehiiv, wordpress: parseWordpress, ghost: parseGhost };

// Which platform an export comes from, and its posts. A ZIP is Substack's when it has posts.csv; a ZIP around a single
// beehiiv CSV, WordPress XML or Ghost JSON is read as that file. expected: the platform the creator picked, if any.
export async function parseExport(bytes, { expected } = {}) {
	let source;
	let result;
	if (isZip(bytes)) {
		const files = await readZipFiles(bytes, {
			accept: (name) => !name.startsWith("__MACOSX/") && /\.(csv|html|xml|json)$/i.test(name),
			maxBytes: MAX_EXPANDED_BYTES,
		});
		const names = [...files.keys()];
		if (names.some((name) => name === "posts.csv" || name.endsWith("/posts.csv"))) {
			source = "substack";
			result = parseSubstack(files);
		} else {
			const single = names.filter((name) => /\.(csv|xml|json)$/i.test(name));
			if (single.length !== 1) throw formatError("This ZIP isn't a Substack export: it has no posts.csv");
			const text = stripBom(new TextDecoder().decode(files.get(single[0])));
			source = detectText(text);
			if (!TEXT_PARSERS[source]) throw formatError("FlockStack can't tell which platform this export comes from");
			result = TEXT_PARSERS[source](text);
		}
	} else {
		const text = stripBom(new TextDecoder().decode(bytes));
		source = detectText(text);
		if (source === "substack") throw formatError("Upload Substack's whole export ZIP: posts.csv alone has no post content");
		if (!TEXT_PARSERS[source]) throw formatError("FlockStack can't tell which platform this export comes from: upload Substack's ZIP, beehiiv's posts CSV, WordPress's XML or Ghost's JSON");
		result = TEXT_PARSERS[source](text);
	}
	if (expected && expected !== source) {
		throw formatError(`This file looks like a ${SOURCE_NAMES[source]} export, not ${SOURCE_NAMES[expected]}`);
	}
	return { source, posts: newestFirst(result.posts), skipped: result.skipped, siteUrl: result.siteUrl ?? null };
}

// A post's HTML before it is cleaned like the editor's (lib/clean-html.js): placeholders from the old platform, beehiiv's
// email layout tables, captions as small text, and links and pictures relative to the old site made absolute, or
// Ghost's __GHOST_URL__ replaced. Without a site address, relative pictures can't be fetched and are dropped.
export function prepareImportedHtml(html, { source, siteUrl }) {
	let body = String(html ?? "");
	const base = siteUrl ? siteUrl.replace(/\/+$/, "") : "";
	body = body.replaceAll("__GHOST_URL__", base);
	body = body
		.replace(/(href|src)=(["'])\{\{[^}]*\}\}\2/gi, '$1="#"')
		.replace(/\{\{[^}]*first_?name[^}]*\}\}/gi, "there")
		.replace(/\{\{[^}]*\}\}/g, "");
	body = body.replace(/<!--[\s\S]*?-->/g, "");
	if (source === "beehiiv") body = body.replace(/<\/?(?:table|tbody|thead|tfoot|tr|td|th)\b[^>]*>/gi, "\n");
	body = body.replace(/<figcaption\b[^>]*>/gi, "<p><small>").replace(/<\/figcaption\s*>/gi, "</small></p>");
	if (base) {
		body = body.replace(/\b(src|href)=(["'])(\/(?!\/)[^"']*)\2/gi, (_, name, quote, path) => `${name}=${quote}${base}${path}${quote}`);
	}
	return body;
}

// A picture's address from the export, absolute: Ghost's __GHOST_URL__ and relative paths need the old site's address.
// null when it can't be fetched.
export function resolveImportedUrl(url, siteUrl) {
	const base = siteUrl ? siteUrl.replace(/\/+$/, "") : "";
	const value = String(url ?? "").replace("__GHOST_URL__", base);
	if (/^https?:\/\//i.test(value)) return value;
	return base && value.startsWith("/") && !value.startsWith("//") ? `${base}${value}` : null;
}

// Pictures a post loses because their address is relative and there's no site address to complete it.
export function countRelativeImages(html) {
	return [...String(html ?? "").matchAll(/<img\b[^>]*?\bsrc=["'](?!https?:\/\/)/gi)].length;
}
