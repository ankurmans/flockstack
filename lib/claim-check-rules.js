import { decodeEntities } from "./editor-blocks.js";
import { markdownToHtml } from "./markdown.js";
import { findLinks } from "./ready-check.js";

// The claim check of the ready-to-send check (docs/CLAIM-CHECK.md): for any issue, which links don't load, which figures in a
// paragraph or list item aren't on any page that paragraph links to, and which paragraphs state figures with no link at all.
// Plain functions of the issue and of the pages read; lib/claim-check.js keeps the result and lib/claim-check-run.js reads
// the pages. Code only: no model call.
//
// maxLinks: links judged per check. maxPages: of those, pages read whole for their figures. maxRequests: every request the
// check makes, robots.txt and redirects included. timeMs: no request starts after it. The result is kept for the issue's
// words (campaignContentHash, lib/campaign-content-hash.js) for cacheMs.
export const CLAIM_CHECK = { maxLinks: 25, maxPages: 12, maxRequests: 60, timeMs: 25_000, concurrency: 4, cacheMs: 24 * 60 * 60_000, runningMs: 3 * 60_000, maxListed: 20 };

const SCALES = { thousand: 1e3, k: 1e3, million: 1e6, mn: 1e6, mm: 1e6, m: 1e6, billion: 1e9, bn: 1e9, b: 1e9, trillion: 1e12, tn: 1e12 };
// A one-letter scale ("5m") may be minutes or metres too, so the bare figure also counts.
const SHORT_SCALES = new Set(["k", "m", "b"]);
const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const BEFORE_MONTH = new RegExp(`\\b${MONTH}\\s*$`, "i");
const AFTER_MONTH = new RegExp(`^\\s*(?:st|nd|rd|th)?\\s*(?:of\\s+)?${MONTH}(?![a-z])`, "i");
// A number that names a thing rather than counts it: "issue 12", "No. 5", "step 2".
const LABEL_BEFORE = /\b(?:no\.|nos\.|number|issue|episode|ep\.|part|chapter|ch\.|page|p\.|pp\.|step|week|day|season|vol\.|volume|version|ver\.|v|rank(?:ed)?|top|level|grade|room|unit|suite|route|highway)\s*$/i;
// Currency, the digits (thousands with commas), a decimal part, then a percent or a scale. Not part of a word ("A320", "Q3",
// "COVID-19"), a version ("1.2.3"), a time ("10:30"), a fraction or date ("3/4"), a tag ("#5") or a thousands group.
const NUMBER =
	/(?<![\p{L}\p{N}_.,/#:'’]|\p{L}-)((?:US|A|C|NZ|HK|S)?[$€£¥₹]\s?)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?![.,]?\d)(?!:\d)(?:(\s?(?:%|percent\b|per\s?cent\b|pct\b))|\s?(thousand|million|billion|trillion|mn|bn|tn)\b|(mm|k|m|b)\b)?/giu;

// Text with nothing a figure should be read from: addresses, email addresses, merge tags, footnote marks and written dates.
function stripNoise(text) {
	return String(text ?? "")
		.replace(/\{\{[^{}]*\}\}/g, " ")
		.replace(/\b(?:https?:\/\/|www\.)\S+/gi, " ")
		.replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, " ")
		.replace(/\b[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\/\S*/gi, " ")
		.replace(/\[\d{1,3}\]/g, " ")
		.replace(/\b\d{4}-\d{1,2}-\d{1,2}(?:[T ][\d:.]+Z?)?\b/g, " ")
		.replace(/\b\d{1,2}([/.-])\d{1,2}\1\d{2,4}\b/g, " ");
}

function round(value) {
	return Number(value.toPrecision(12));
}

// Every figure in a text: { token, value, values (what it may be compared as), unit (a scaled figure's rounding step), isClaim }.
// isClaim: worth checking against a source. Left out of that: years, dates, times, ordinals, decades, a list's numbering, labels
// ("issue 12") and a bare whole number under 10.
export function figuresIn(text) {
	const source = stripNoise(text);
	const figures = [];
	for (const match of source.matchAll(NUMBER)) {
		const [whole, currency, digits, decimals = "", percent, wordScale, shortScale] = match;
		const scaleName = (wordScale ?? shortScale ?? "").toLowerCase();
		const scale = SCALES[scaleName] ?? 1;
		const raw = Number(`${digits.replaceAll(",", "")}${decimals ? `.${decimals}` : ""}`);
		if (!Number.isFinite(raw)) continue;
		const value = round(raw * scale);
		const before = source.slice(Math.max(0, match.index - 24), match.index);
		const after = source.slice(match.index + whole.length, match.index + whole.length + 24);
		const isPlain = !currency && !percent && !scaleName && !decimals;
		const lineStart = /(?:^|\n)\s*$/.test(before);
		const skip =
			/^(?:st|nd|rd|th)\b/i.test(after) ||
			/^'?s\b/i.test(after) ||
			/^\s?(?:a\.?m\.?|p\.?m\.?)(?![a-z])/i.test(after) ||
			(isPlain && BEFORE_MONTH.test(before)) ||
			(isPlain && AFTER_MONTH.test(after)) ||
			(isPlain && LABEL_BEFORE.test(before)) ||
			(isPlain && lineStart && /^[.)]\s/.test(after)) ||
			(isPlain && digits.length === 4 && raw >= 1800 && raw <= 2199) ||
			(isPlain && raw < 10) ||
			(isPlain && digits.length > 1 && digits.startsWith("0"));
		const values = SHORT_SCALES.has(scaleName) ? [value, round(raw)] : [value];
		figures.push({ token: whole.trim(), value, values, unit: scale > 1 ? scale / 10 ** decimals.length : 0, isClaim: !skip });
	}
	return figures;
}

// What a page's text can back: every figure on it, as values.
export function pageValues(text) {
	return new Set(figuresIn(text).flatMap(({ values }) => values));
}

// A figure is on a page when the page has it in any form ($1.7 billion, 1.7bn, 1,700,000,000; 8.0% and 8%), or, for a figure
// with a scale, when the page has a more exact one that rounds to it (1.7 billion for 1,712,000,000).
export function isOnPage(figure, values, sorted = [...values]) {
	if (figure.values.some((value) => values.has(value))) return true;
	if (!figure.unit) return false;
	const half = figure.unit / 2;
	return sorted.some((value) => Math.abs(value - figure.value) <= half * (1 + 1e-9));
}

const BOUNDARY = /<\/?(p|li|ul|ol|h[1-6]|blockquote|div|section|article|aside|header|footer|table|thead|tbody|tfoot|tr|td|th|caption|figure|figcaption|dl|dd|dt|pre|hr|details|summary)\b[^>]*>/gi;

function plainText(html) {
	return decodeEntities(String(html).replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, " "))
		.replace(/[ \t\f\v ]+/g, " ")
		.replace(/\s*\n\s*/g, "\n")
		.trim();
}

// The issue's HTML as the email has it: Markdown rendered with the renderer the send uses.
export function issueHtml(campaign) {
	return campaign.format === "markdown" ? markdownToHtml(campaign.markdown ?? "") : String(campaign.html ?? "");
}

// The issue as the check reads it: each paragraph, list item, heading or table cell with its text, its links and its figures;
// the subject and the preview text as headings. A nested list's items are units of their own.
export function issueUnits(campaign) {
	const html = issueHtml(campaign).replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ");
	const units = [];
	const push = (kind, part, field = "body") => {
		const text = plainText(part);
		if (text) units.push({ kind, field, text, links: findLinks(part), figures: figuresIn(text).filter(({ isClaim }) => isClaim) });
	};
	push("heading", String(campaign.subject ?? "").replace(/[<>&]/g, " "), "subject");
	push("heading", String(campaign.previewText ?? "").replace(/[<>&]/g, " "), "preview");
	let kind = "text";
	let start = 0;
	for (const match of html.matchAll(BOUNDARY)) {
		push(kind, html.slice(start, match.index));
		const isOpening = !match[0].startsWith("</");
		kind = isOpening && /^h[1-6]$/i.test(match[1]) ? "heading" : "text";
		start = match.index + match[0].length;
	}
	push(kind, html.slice(start));
	return units;
}

// The issue's links in the order the check takes them: first those a paragraph with figures needs read, then the rest.
// pages: the links to read whole, maxPages at most.
export function planChecks(units) {
	const read = [];
	for (const unit of units) if (unit.kind !== "heading" && unit.figures.length) for (const url of unit.links) if (!read.includes(url)) read.push(url);
	const all = [...read];
	for (const unit of units) for (const url of unit.links) if (!all.includes(url)) all.push(url);
	const judged = all.slice(0, CLAIM_CHECK.maxLinks);
	return { links: judged, pages: read.filter((url) => judged.includes(url)).slice(0, CLAIM_CHECK.maxPages), total: all.length };
}

function snippet(text) {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

// The report. linkStates: url -> { state: ok | broken | unsure, reason }, for the links that were judged. pages: url -> the
// page's figures (a Set from pageValues) for each page that was read, or { problem } for one that couldn't be.
// failures: dead links, figures not on their pages, figures with no source. unconfirmed: what couldn't be read, so isn't known.
export function buildClaimReport({ units, linkStates = {}, pages = {}, total = 0, checkedAt = new Date() }) {
	const deadLinks = [];
	const unsureLinks = [];
	for (const [url, result] of Object.entries(linkStates)) {
		if (result.state === "broken") deadLinks.push({ url, reason: result.reason ?? "doesn't load" });
		else if (result.state === "unsure") unsureLinks.push({ url, reason: result.reason ?? "couldn't be confirmed" });
	}
	const read = Object.entries(pages).filter(([, page]) => page.values);
	const sorted = new Map(read.map(([url, page]) => [url, [...page.values]]));
	const unmatched = [];
	const unconfirmed = [];
	const uncited = [];
	const issueLinks = [...new Set(units.flatMap(({ links }) => links))];
	const whyUnread = (sources) => sources.map((url) => pages[url]?.problem).find(Boolean) ?? `not read: the check reads ${CLAIM_CHECK.maxPages} pages and ${CLAIM_CHECK.maxLinks} links at most`;
	let figuresChecked = 0;
	for (const unit of units) {
		if (!unit.figures.length) continue;
		const isHeading = unit.kind === "heading";
		if (!isHeading && !unit.links.length) {
			uncited.push({ text: snippet(unit.text), figures: [...new Set(unit.figures.map(({ token }) => token))] });
			continue;
		}
		// A heading, the subject and the preview sum up the issue: their figures may be on any page it links to.
		const sources = isHeading ? issueLinks : unit.links;
		if (!sources.length) continue;
		figuresChecked += unit.figures.length;
		const readSources = sources.filter((url) => pages[url]?.values);
		const allRead = readSources.length === sources.length;
		for (const figure of unit.figures) {
			if (readSources.some((url) => isOnPage(figure, pages[url].values, sorted.get(url)))) continue;
			const entry = { figure: figure.token, text: snippet(unit.text), urls: sources.slice(0, 3) };
			if (allRead) unmatched.push(entry);
			else unconfirmed.push({ ...entry, reason: whyUnread(sources) });
		}
	}
	const failures = deadLinks.length + unmatched.length + uncited.length;
	const cap = (list) => list.slice(0, CLAIM_CHECK.maxListed);
	return {
		deadLinks: cap(deadLinks),
		unsureLinks: cap(unsureLinks),
		unmatchedFigures: cap(unmatched),
		unconfirmedFigures: cap(unconfirmed),
		uncitedClaims: cap(uncited),
		counts: { deadLinks: deadLinks.length, unsureLinks: unsureLinks.length, unmatchedFigures: unmatched.length, unconfirmedFigures: unconfirmed.length, uncitedClaims: uncited.length },
		failures,
		figuresChecked,
		linksChecked: Object.keys(linkStates).length,
		linksTotal: total,
		pagesRead: read.length,
		checkedAt: new Date(checkedAt).toISOString(),
	};
}
