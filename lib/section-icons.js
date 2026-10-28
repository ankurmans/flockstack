import { SECTION_ICON_KEYS } from "./briefing-rules.js";

// The section icons of issues and briefings (docs/VISUALS-DESIGN.md): one key per section, drawn from lucide, the dashboard's icon
// set. The drawings are lucide's own (ISC license), copied here so the share card, the icon PNGs and the issue page draw them
// without lucide-react, which would bring React into the readers Worker; tests/section-icons.test.mjs holds them to lucide's.
export { SECTION_ICON_KEYS };

export const SECTION_ICON_NAMES = {
	lead: "newspaper",
	"market-pulse": "activity",
	earnings: "bar-chart-3",
	roundup: "list",
	"deal-flow": "handshake",
	regulation: "scale",
	people: "users",
	launches: "rocket",
	"coming-up": "calendar",
	generic: "file-text",
};

// [element, attributes] pairs on lucide's 24 by 24 grid, stroked, never filled.
export const SECTION_ICON_NODES = {
	lead: [
		["path", { d: "M15 18h-5" }],
		["path", { d: "M18 14h-8" }],
		["path", { d: "M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-4 0v-9a2 2 0 0 1 2-2h2" }],
		["rect", { width: "8", height: "4", x: "10", y: "6", rx: "1" }],
	],
	"market-pulse": [["path", { d: "M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" }]],
	earnings: [
		["path", { d: "M3 3v16a2 2 0 0 0 2 2h16" }],
		["path", { d: "M18 17V9" }],
		["path", { d: "M13 17V5" }],
		["path", { d: "M8 17v-3" }],
	],
	roundup: [
		["path", { d: "M3 5h.01" }],
		["path", { d: "M3 12h.01" }],
		["path", { d: "M3 19h.01" }],
		["path", { d: "M8 5h13" }],
		["path", { d: "M8 12h13" }],
		["path", { d: "M8 19h13" }],
	],
	"deal-flow": [
		["path", { d: "m11 17 2 2a1 1 0 1 0 3-3" }],
		["path", { d: "m14 14 2.5 2.5a1 1 0 1 0 3-3l-3.88-3.88a3 3 0 0 0-4.24 0l-.88.88a1 1 0 1 1-3-3l2.81-2.81a5.79 5.79 0 0 1 7.06-.87l.47.28a2 2 0 0 0 1.42.25L21 4" }],
		["path", { d: "m21 3 1 11h-2" }],
		["path", { d: "M3 3 2 14l6.5 6.5a1 1 0 1 0 3-3" }],
		["path", { d: "M3 4h8" }],
	],
	regulation: [
		["path", { d: "M12 3v18" }],
		["path", { d: "m19 8 3 8a5 5 0 0 1-6 0zV7" }],
		["path", { d: "M3 7h1a17 17 0 0 0 8-2 17 17 0 0 0 8 2h1" }],
		["path", { d: "m5 8 3 8a5 5 0 0 1-6 0zV7" }],
		["path", { d: "M7 21h10" }],
	],
	people: [
		["path", { d: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" }],
		["path", { d: "M16 3.128a4 4 0 0 1 0 7.744" }],
		["path", { d: "M22 21v-2a4 4 0 0 0-3-3.87" }],
		["circle", { cx: "9", cy: "7", r: "4" }],
	],
	launches: [
		["path", { d: "M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" }],
		["path", { d: "M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09" }],
		["path", { d: "M9 12a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.4 22.4 0 0 1-4 2z" }],
		["path", { d: "M9 12H4s.55-3.03 2-4c1.62-1.08 5 .05 5 .05" }],
	],
	"coming-up": [
		["path", { d: "M8 2v3" }],
		["path", { d: "M16 2v3" }],
		["rect", { x: "3", y: "3", width: "18", height: "18", rx: "2" }],
		["path", { d: "M3 9h18" }],
	],
	generic: [
		["path", { d: "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" }],
		["path", { d: "M14 2v5a1 1 0 0 0 1 1h5" }],
		["path", { d: "M10 9H8" }],
		["path", { d: "M16 13H8" }],
		["path", { d: "M16 17H8" }],
	],
};

// The titles a section is known by, beyond its key: the briefing templates' ("Earnings and filings", "Headline roundup",
// "Regulation and rates", "People moves", "Product and tech launches") and their usual short forms. A whole title has to match:
// a story's headline that mentions markets is not the Market pulse section.
const KNOWN_TITLES = {
	lead: ["lead", "the lead", "top story", "top stories"],
	"market-pulse": ["market pulse", "markets"],
	earnings: ["earnings", "earnings and filings", "filings"],
	roundup: ["roundup", "headline roundup", "headlines", "in brief"],
	"deal-flow": ["deal flow", "deals"],
	regulation: ["regulation", "regulation and rates"],
	people: ["people", "people moves"],
	launches: ["launches", "product launches", "product and tech launches"],
	"coming-up": ["coming up", "the week ahead", "week ahead"],
};
const TITLE_KEYS = new Map(Object.entries(KNOWN_TITLES).flatMap(([key, titles]) => titles.map((title) => [title, key])));

function normalize(text) {
	return String(text ?? "")
		.toLowerCase()
		.replace(/&amp;|&/g, " and ")
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

function titleKey(title) {
	return TITLE_KEYS.get(normalize(title)) ?? null;
}

export function isSectionIconKey(key) {
	return SECTION_ICON_KEYS.includes(key);
}

// A section's icon: the one it names, else the one its id is, else the one its title is known by, else generic.
export function iconKeyForSection({ id, icon, title } = {}) {
	if (isSectionIconKey(icon)) return icon;
	if (isSectionIconKey(id)) return id;
	return titleKey(title) ?? "generic";
}

const H2_PATTERN = /<h2\b([^>]*)>([\s\S]*?)<\/h2>/gi;

function headingText(inner) {
	return inner
		.replace(/<[^>]*>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

// An issue is sectioned when at least two of its second-level headings are known section titles (a briefing's are): one such
// heading in an ordinary issue ("## People") stays a plain heading. Each heading's key, or null for one that is not known.
function knownHeadings(html) {
	const keys = [...String(html ?? "").matchAll(H2_PATTERN)].map((match) => titleKey(headingText(match[2])));
	return keys.filter(Boolean).length >= 2 ? keys : null;
}

// The keys of an issue's sections in order, for its share card: from its rendered HTML's <h2> headings.
export function getSectionKeys(html) {
	return (knownHeadings(html) ?? []).filter(Boolean);
}

// Each known section heading of a sectioned issue with what icon() makes of its key and title put before its text, which
// stays as it was: the heading reads the same without the icon.
export function addSectionIcons(html, icon) {
	const keys = knownHeadings(html);
	if (!keys) return html;
	let index = 0;
	return html.replace(H2_PATTERN, (match, attributes, inner) => {
		const key = keys[index++];
		return key ? `<h2${attributes}>${icon(key, headingText(inner))}${inner}</h2>` : match;
	});
}

function escapeAttribute(value) {
	return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// An icon as inline SVG markup for a web page, in the text's color unless a color is given.
export function sectionIconSvg(key, { size = 20, color = "currentColor", className = "" } = {}) {
	const nodes = SECTION_ICON_NODES[key] ?? SECTION_ICON_NODES.generic;
	const children = nodes.map(([element, attributes]) => `<${element} ${Object.entries(attributes).map(([name, value]) => `${name}="${escapeAttribute(value)}"`).join(" ")}/>`).join("");
	return `<svg${className ? ` class="${className}"` : ""} width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${escapeAttribute(color)}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${children}</svg>`;
}
