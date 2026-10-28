import { getArchiveUrls } from "./archive-hosts.js";
import { getBrand } from "./brand.js";
import { markdownToHtml } from "./markdown.js";
import { getSectionKeys } from "./section-icons.js";

// The share card (app/archive/[slug]/og, docs/VISUALS-DESIGN.md): what it shows, and a hash of that, so its address changes when
// the card does and stays the same, cached for a year, while it doesn't. A change to the template raises the version.
export const CARD_TEMPLATE_VERSION = 3;
export const CARD_SIZE = { width: 1200, height: 630 };
export const MAX_CARD_ICONS = 4;

// The day an issue went out: startedAt, set as its send starts, so every email of the send and the page after it carry the same
// card (sentAt comes only as the last batch goes). A draft has none.
export function getCardDate(issue) {
	const value = issue?.startedAt || issue?.sentAt;
	return value ? new Date(value).toISOString().slice(0, 10) : "";
}

// An issue's rendered HTML, where its section headings are: rich issues hold it, Markdown ones are rendered.
function issueHtml(issue) {
	if (issue?.format === "markdown") return markdownToHtml(issue.markdown ?? "");
	return issue?.format === "rich" || issue?.format === undefined ? (issue?.html ?? "") : "";
}

// Whether the issue object carries its text: a list's issues don't, so their card has no version (and no section icons to hash).
export function hasIssueContent(issue) {
	return typeof issue?.markdown === "string" || typeof issue?.html === "string";
}

// Where the website is, as the card prints it: quotesweep.com/newsletter/underwritten for a mount, the host for a domain.
function getCardHost(siteIndex) {
	const url = new URL(siteIndex);
	return `${url.host.replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}`;
}

// Everything the card shows, and nothing else. issue: null for the newsletter's own card.
export function getCardInputs(newsletter, issue = null, { appUrl } = {}) {
	const brand = getBrand(newsletter);
	const inputs = {
		version: CARD_TEMPLATE_VERSION,
		name: newsletter?.name ?? "",
		accent: brand.accent,
		logo: newsletter?.imageUrl ?? "",
		publisher: brand.publisher,
		host: getCardHost(getArchiveUrls(newsletter, appUrl ? { appUrl } : undefined).siteIndex),
	};
	if (!issue) return { ...inputs, description: newsletter?.description ?? "" };
	return {
		...inputs,
		title: issue.subject ?? "",
		date: getCardDate(issue),
		icons: getSectionKeys(issueHtml(issue)).filter((key, index, keys) => keys.indexOf(key) === index).slice(0, MAX_CARD_ICONS),
	};
}

// FNV-1a over the inputs' JSON, twice with different seeds: 16 hex characters, plain JavaScript so it runs in any bundle.
export function hashCardInputs(inputs) {
	const text = JSON.stringify(inputs);
	let first = 0x811c9dc5;
	let second = 0x01000193 ^ text.length;
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		first = Math.imul(first ^ code, 0x01000193) >>> 0;
		second = Math.imul(second ^ code, 0x5bd1e995) >>> 0;
		second ^= second >>> 15;
	}
	return `${first.toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

export function getCardHash(newsletter, issue = null, options) {
	return hashCardInputs(getCardInputs(newsletter, issue, options));
}

// Where a card is kept in the IMAGES bucket.
export function getCardKey(newsletterId, hash) {
	return `cards/${newsletterId}/${hash}.png`;
}
