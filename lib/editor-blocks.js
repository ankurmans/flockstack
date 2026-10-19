import { parseEmbed } from "./embeds.js";

// The editor's blocks past plain text, as an issue stores them: markers the cleaner keeps (lib/clean-html.js) and
// this module turns into an email's tables or the archive's markup. Nothing a writer typed becomes markup here
// without being escaped, and every address is read again: links must be http(s), embeds go through parseEmbed.
//   <div data-button=""><a href="https://...">Label</a></div>
//   <div data-embed="https://youtu.be/..."></div>
//   <div data-paywall=""></div>                       what follows is for paid readers
//   <div data-columns=""><div data-column="">…</div><div data-column="">…</div></div>
//   <div data-file="" data-size="1234"><a href="https://cdn/...">report.pdf</a></div>
//   <sup data-footnote="">The note's text</sup>
//   <div data-poll="<id>"><p>Question</p><ol><li>Option</li>…</ol></div>
// Client components render emails for the preview, so this stays free of server modules.

export const DEFAULT_ACCENT = "#18181b";
export const ACCENT_PATTERN = /^#[0-9a-f]{6}$/i;
export const MAX_POLL_OPTIONS = 6;
export const MIN_POLL_OPTIONS = 2;
const FONT_STACK = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const VOID_TAGS = new Set(["br", "hr", "img", "input", "meta", "link", "col", "wbr", "source"]);
const TAG_PATTERN = /<(\/?)([a-z][a-z0-9]*)\b([^>]*)>/gi;
const BLOCK_PATTERN = /\sdata-(button|embed|columns|file|poll)\b/i;
// A vote link in an email: filled in for each reader after the links are tracked (lib/sending-rules.js), so it's
// never wrapped in a click link.
export const POLL_LINK_PATTERN = /\{\{poll:([a-f0-9]{24}):(\d)\}\}/g;
const FILE_TYPES = { pdf: "PDF", zip: "ZIP", epub: "EPUB", docx: "Word", xlsx: "Excel", pptx: "PowerPoint", csv: "CSV", txt: "Text", mp3: "MP3", m4a: "Audio" };

export function escapeText(value) {
	return String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

export function decodeEntities(value) {
	return String(value ?? "")
		.replace(/&#(\d{1,7});/g, (_, code) => safeChar(Number(code)))
		.replace(/&#x([0-9a-f]{1,6});/gi, (_, code) => safeChar(Number.parseInt(code, 16)))
		.replaceAll("&quot;", '"')
		.replaceAll("&#39;", "'")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&nbsp;", " ")
		.replaceAll("&amp;", "&");
}

function safeChar(code) {
	return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
}

// An element's text, as plain words.
export function textOf(html) {
	return decodeEntities(String(html ?? "").replace(/<[^>]*>/g, " "))
		.replace(/\s+/g, " ")
		.trim();
}

export function readAttribute(tag, name) {
	const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag);
	return match ? decodeEntities(match[1] ?? match[2] ?? match[3] ?? "") : null;
}

export function getAccent(newsletter) {
	return ACCENT_PATTERN.test(newsletter?.accentColor ?? "") ? newsletter.accentColor.toLowerCase() : DEFAULT_ACCENT;
}

// Black or white, whichever contrasts more with the color: the two ratios are equal at a luminance of about 0.179.
export function getTextOn(hex) {
	const [r, g, b] = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255).map((channel) =>
		channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
	);
	return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.179 ? "#09090b" : "#ffffff";
}

function isHttpUrl(value) {
	return /^https?:\/\/[^\s"'<>]+$/i.test(String(value ?? ""));
}

// Top-level elements whose start tag `test` accepts, each with what's between its start and its own end tag, nested
// elements of its name counted. Elements that don't pass are looked into, so a block inside a box is found.
export function findElements(html, test) {
	const found = [];
	let open = null;
	for (const match of html.matchAll(TAG_PATTERN)) {
		const [tag, slash, rawName] = match;
		const name = rawName.toLowerCase();
		if (open) {
			if (name !== open.name || VOID_TAGS.has(name)) continue;
			open.depth += slash ? -1 : 1;
			if (open.depth === 0) {
				found.push({ start: open.start, end: match.index + tag.length, name, tag: open.tag, inner: html.slice(open.innerStart, match.index) });
				open = null;
			}
			continue;
		}
		if (slash || VOID_TAGS.has(name) || !test(tag, name)) continue;
		if (/\/\s*>$/.test(tag)) {
			found.push({ start: match.index, end: match.index + tag.length, name, tag, inner: "" });
			continue;
		}
		open = { name, tag, start: match.index, innerStart: match.index + tag.length, depth: 1 };
	}
	return found;
}

function replaceFound(html, found, render) {
	let result = "";
	let cursor = 0;
	for (const element of found) {
		result += html.slice(cursor, element.start) + render(element);
		cursor = element.end;
	}
	return result + html.slice(cursor);
}

// Where the writer's paywall break is, outside any other element: what comes before it is for everyone.
// { before, after, hasBreak }; a break inside a box or a column doesn't count.
export function splitAtPaywall(html) {
	const text = String(html ?? "");
	let depth = 0;
	for (const match of text.matchAll(TAG_PATTERN)) {
		const [tag, slash, rawName] = match;
		const name = rawName.toLowerCase();
		if (VOID_TAGS.has(name) || /\/\s*>$/.test(tag)) continue;
		if (slash) {
			depth = Math.max(0, depth - 1);
			continue;
		}
		if (depth === 0 && name === "div" && /\sdata-paywall\b/i.test(tag)) {
			const close = text.indexOf("</div>", match.index + tag.length);
			const end = close === -1 ? match.index + tag.length : close + "</div>".length;
			return { before: text.slice(0, match.index), after: text.slice(end), hasBreak: true };
		}
		depth += 1;
	}
	return { before: text, after: "", hasBreak: false };
}

export function hasPaywallBreak(html) {
	return splitAtPaywall(html).hasBreak;
}

// The polls an issue has, by ID, with what its block shows.
export function findPolls(html) {
	return findElements(String(html ?? ""), (tag, name) => name === "div" && /\sdata-poll=/i.test(tag))
		.map(readPoll)
		.filter(Boolean);
}

function readPoll({ tag, inner }) {
	const id = readAttribute(tag, "data-poll")?.toLowerCase();
	if (!/^[a-f0-9]{24}$/.test(id ?? "")) return null;
	const question = textOf(/<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(inner)?.[1] ?? "");
	const options = [...inner.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map(([, item]) => textOf(item)).filter(Boolean).slice(0, MAX_POLL_OPTIONS);
	return { id, question, options };
}

function formatBytes(bytes) {
	if (!Number.isFinite(bytes) || bytes <= 0) return "";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
}

function readFile({ tag, inner }) {
	const link = /<a\b[^>]*>([\s\S]*?)<\/a>/i.exec(inner);
	const href = link && readAttribute(link[0], "href");
	if (!isHttpUrl(href)) return null;
	const name = textOf(link[1]) || "Download";
	const extension = /\.([a-z0-9]{2,5})$/i.exec(name)?.[1]?.toLowerCase() ?? /\.([a-z0-9]{2,5})(?:$|\?)/i.exec(href)?.[1]?.toLowerCase();
	const size = formatBytes(Number(readAttribute(tag, "data-size")));
	return { href, name, meta: [FILE_TYPES[extension], size].filter(Boolean).join(" · ") };
}

function readButton({ inner }) {
	const link = /<a\b[^>]*>([\s\S]*?)<\/a>/i.exec(inner);
	const href = link && readAttribute(link[0], "href");
	const label = textOf(link?.[1] ?? inner);
	return isHttpUrl(href) && label ? { href, label } : null;
}

function readColumns(inner) {
	return findElements(inner, (tag, name) => name === "div" && /\sdata-column\b/i.test(tag)).map((column) => column.inner);
}

// ---- Email: tables and inline styles, read in Gmail, Apple Mail and Outlook's Word engine alike.

export function emailButton({ href, label }, accent = DEFAULT_ACCENT) {
	const text = getTextOn(accent);
	return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:24px auto;border-collapse:separate;"><tr><td align="center" bgcolor="${accent}" style="border-radius:8px;background:${accent};padding:12px 24px;"><a href="${escapeText(href)}" target="_blank" style="display:inline-block;font-family:${FONT_STACK};font-size:16px;font-weight:600;line-height:1.2;color:${text};text-decoration:none;">${escapeText(label)}</a></td></tr></table>`;
}

function emailCard(body) {
	return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;border:1px solid #e4e4e7;border-radius:12px;border-collapse:separate;"><tr><td style="padding:16px 20px;font-family:${FONT_STACK};font-size:15px;line-height:1.5;color:#27272a;">${body}</td></tr></table>`;
}

function emailEmbed(embed, accent) {
	if (embed.thumbnail) {
		return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;"><tr><td align="center"><a href="${escapeText(embed.url)}" target="_blank" style="text-decoration:none;"><img src="${escapeText(embed.thumbnail)}" width="560" alt="${escapeText(embed.action)}" style="display:block;width:100%;max-width:560px;height:auto;border:0;border-radius:8px;"></a></td></tr><tr><td align="center" style="padding:8px 0 0;font-family:${FONT_STACK};font-size:14px;"><a href="${escapeText(embed.url)}" target="_blank" style="color:${accent};font-weight:600;text-decoration:none;">${escapeText(embed.action)}</a></td></tr></table>`;
	}
	const shown = embed.url.replace(/^https:\/\/(www\.)?/, "");
	return emailCard(
		`<div style="font-size:13px;color:#71717a;">${escapeText(embed.name)}</div><div style="margin-top:4px;"><a href="${escapeText(embed.url)}" target="_blank" style="color:${accent};font-weight:600;text-decoration:none;">${escapeText(embed.action)}</a></div><div style="margin-top:2px;font-size:13px;color:#a1a1aa;word-break:break-all;">${escapeText(shown)}</div>`
	);
}

function emailFile(file, accent) {
	return emailCard(
		`<div><a href="${escapeText(file.href)}" target="_blank" style="color:${accent};font-weight:600;text-decoration:none;">${escapeText(file.name)}</a></div>${file.meta ? `<div style="margin-top:2px;font-size:13px;color:#71717a;">${escapeText(file.meta)} · Download</div>` : ""}`
	);
}

function emailPoll(poll, accent) {
	const options = poll.options
		.map(
			(option, index) =>
				`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px;border-collapse:separate;"><tr><td style="border:1px solid ${accent};border-radius:8px;"><a href="{{poll:${poll.id}:${index}}}" target="_blank" style="display:block;padding:10px 14px;font-family:${FONT_STACK};font-size:15px;font-weight:600;line-height:1.3;color:${accent};text-decoration:none;">${escapeText(option)}</a></td></tr></table>`
		)
		.join("");
	return emailCard(`<p style="margin:0 0 12px;font-size:17px;font-weight:600;line-height:1.4;color:#09090b;">${escapeText(poll.question)}</p>${options}<p style="margin:4px 0 0;font-size:12px;color:#a1a1aa;">One click votes. You can change your answer.</p>`);
}

// Two columns side by side that wrap to one under the other on a narrow screen without a media query; Outlook's Word
// engine gets a table instead, in conditional comments.
function emailColumns(columns) {
	const cells = columns.slice(0, 2).map((inner, index) => `<div style="display:inline-block;width:100%;max-width:280px;vertical-align:top;font-size:16px;line-height:1.65;text-align:left;"><div style="padding:0 ${index === 0 ? 12 : 0}px 0 ${index === 0 ? 0 : 12}px;">${inner}</div></div>`);
	return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 16px;"><tr><td valign="top" style="font-size:0;text-align:left;"><!--[if mso]><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td width="50%" valign="top"><![endif]-->${cells[0] ?? ""}<!--[if mso]></td><td width="50%" valign="top"><![endif]-->${cells[1] ?? ""}<!--[if mso]></td></tr></table><![endif]--></td></tr></table>`;
}

// accent: the newsletter's color for buttons and links in blocks.
export function renderEmailBlocks(html, { accent = DEFAULT_ACCENT } = {}) {
	const found = findElements(String(html ?? ""), (tag, name) => name === "div" && BLOCK_PATTERN.test(tag));
	return replaceFound(html, found, (element) => {
		const kind = BLOCK_PATTERN.exec(element.tag)[1].toLowerCase();
		if (kind === "columns") return emailColumns(readColumns(element.inner).map((inner) => renderEmailBlocks(inner, { accent })));
		if (kind === "button") {
			const button = readButton(element);
			return button ? emailButton(button, accent) : "";
		}
		if (kind === "embed") {
			const embed = parseEmbed(readAttribute(element.tag, "data-embed"));
			return embed ? emailEmbed(embed, accent) : "";
		}
		if (kind === "file") {
			const file = readFile(element);
			return file ? emailFile(file, accent) : "";
		}
		const poll = readPoll(element);
		return poll && poll.options.length >= MIN_POLL_OPTIONS ? emailPoll(poll, accent) : "";
	});
}

// Tables written in the editor, styled inline for clients that drop <style>. Before blocks become tables of their own.
export function styleEmailTables(html) {
	return String(html ?? "")
		.replace(/<table>/g, '<table width="100%" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 16px;border-collapse:collapse;font-size:15px;line-height:1.5;">')
		.replace(/<th\b([^>]*)>/g, '<th$1 style="padding:8px 10px;border:1px solid #e4e4e7;background:#f4f4f5;text-align:left;vertical-align:top;font-weight:600;">')
		.replace(/<td\b([^>]*)>/g, '<td$1 style="padding:8px 10px;border:1px solid #e4e4e7;text-align:left;vertical-align:top;">')
		.replace(/<(t[hd])\b([^>]*)><p>/g, '<$1$2><p style="margin:0;">');
}

// A free reader's email ends at the break with this, instead of the paid part.
export function emailUpgradeCard({ upgradeUrl, accent = DEFAULT_ACCENT }) {
	const button = isHttpUrl(upgradeUrl) ? emailButton({ href: upgradeUrl, label: "Upgrade to keep reading" }, accent) : "";
	return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:32px 0;border-radius:12px;background:#f4f4f5;border-collapse:separate;"><tr><td align="center" style="padding:28px 24px 12px;font-family:${FONT_STACK};"><p style="margin:0 0 8px;font-size:18px;font-weight:600;line-height:1.35;color:#09090b;">The rest of this issue is for paid subscribers</p><p style="margin:0;font-size:15px;line-height:1.6;color:#52525b;">Upgrade to continue reading, and get every paid issue in your inbox.</p>${button || '<p style="margin:0 0 16px;"></p>'}</td></tr></table>`;
}

// Where the paid part starts, in a test email and the editor's preview, which show everything.
export function emailPaywallMarker() {
	return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:32px 0;"><tr><td style="border-top:2px dashed #d4d4d8;padding:8px 0 0;font-family:${FONT_STACK};font-size:12px;font-weight:600;color:#71717a;text-align:center;">Paid subscribers read on from here. Free subscribers get an upgrade card instead.</td></tr></table>`;
}

// ---- Footnotes: numbered in reading order, listed at the end.

const FOOTNOTE_PATTERN = /<sup\b([^>]*\sdata-footnote\s*=[^>]*)>([\s\S]*?)<\/sup>/gi;

export function renderFootnotes(html, { mode = "email" } = {}) {
	const notes = [];
	const body = String(html ?? "").replace(FOOTNOTE_PATTERN, (...[, , inner]) => {
		const text = textOf(inner);
		if (!text) return "";
		notes.push(text.slice(0, 1000));
		const number = notes.length;
		return mode === "web"
			? `<sup id="fnref-${number}" data-footnote-ref=""><a href="#fn-${number}" aria-describedby="footnotes-label">${number}</a></sup>`
			: `<sup style="font-size:12px;line-height:0;">[${number}]</sup>`;
	});
	if (notes.length === 0) return body;
	if (mode === "web") {
		const items = notes.map((note, index) => `<li id="fn-${index + 1}">${escapeText(note)} <a href="#fnref-${index + 1}" aria-label="Back to the text">↩</a></li>`).join("");
		return `${body}<section data-footnotes=""><h2 id="footnotes-label">Notes</h2><ol>${items}</ol></section>`;
	}
	// Numbered like the references, not as a list, so the plain-text version numbers them the same.
	const items = notes.map((note, index) => `<p style="margin:0 0 6px;font-size:13px;line-height:1.5;color:#52525b;">[${index + 1}] ${escapeText(note)}</p>`).join("");
	return `${body}<hr style="border:0;border-top:1px solid #e4e4e7;margin:32px 0 16px;">${items}`;
}

// ---- The archive's issue page: frames for embeds, links for files and polls. Runs after the sanitizer, which
// keeps the markers.

function webEmbed(embed) {
	const caption = `<a href="${escapeText(embed.url)}" target="_blank" rel="noopener noreferrer">${escapeText(embed.action)}</a>`;
	if (!embed.frame) return `<div data-embed-card=""><span>${escapeText(embed.name)}</span>${caption}</div>`;
	const size = embed.frame.ratio ? `aspect-ratio:${embed.frame.ratio};height:auto;` : `height:${embed.frame.height}px;`;
	return `<figure data-embed-frame=""><iframe src="${escapeText(embed.frame.src)}" title="${escapeText(`${embed.name} embed`)}" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-popups allow-presentation" allow="encrypted-media; picture-in-picture; fullscreen" allowfullscreen style="width:100%;${size}border:0;"></iframe><figcaption>${caption}</figcaption></figure>`;
}

function webFile(file) {
	return `<div data-file-card=""><a href="${escapeText(file.href)}" download target="_blank" rel="noopener">${escapeText(file.name)}</a>${file.meta ? `<span>${escapeText(file.meta)}</span>` : ""}</div>`;
}

function webPoll(poll, pollUrl) {
	const options = poll.options.map((option, index) => `<li><a href="${escapeText(pollUrl(poll.id, index))}" rel="nofollow">${escapeText(option)}</a></li>`).join("");
	return `<div data-poll-card=""><p>${escapeText(poll.question)}</p><ol>${options}</ol></div>`;
}

function webButton(button, accent) {
	return `<p data-button=""><a href="${escapeText(button.href)}" style="background:${accent};color:${getTextOn(accent)};">${escapeText(button.label)}</a></p>`;
}

// pollUrl(id, index): the page a web reader votes on.
export function renderWebBlocks(html, { accent = DEFAULT_ACCENT, pollUrl = (id, index) => `/poll?p=${id}&o=${index}` } = {}) {
	const found = findElements(String(html ?? ""), (tag, name) => name === "div" && BLOCK_PATTERN.test(tag));
	const body = replaceFound(html, found, (element) => {
		const kind = BLOCK_PATTERN.exec(element.tag)[1].toLowerCase();
		if (kind === "columns") {
			const columns = readColumns(element.inner).slice(0, 2).map((inner) => `<div data-column="">${renderWebBlocks(inner, { accent, pollUrl })}</div>`);
			return `<div data-columns="">${columns.join("")}</div>`;
		}
		if (kind === "button") {
			const button = readButton(element);
			return button ? webButton(button, accent) : "";
		}
		if (kind === "embed") {
			const embed = parseEmbed(readAttribute(element.tag, "data-embed"));
			return embed ? webEmbed(embed) : "";
		}
		if (kind === "file") {
			const file = readFile(element);
			return file ? webFile(file) : "";
		}
		const poll = readPoll(element);
		return poll && poll.options.length >= MIN_POLL_OPTIONS ? webPoll(poll, pollUrl) : "";
	});
	return body;
}
