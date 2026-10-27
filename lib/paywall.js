import { filterAudienceBlocks } from "./audience-blocks.js";
import { expandHtmlSnippets } from "./html-snippets.js";
import { cleanRichHtml } from "./clean-html.js";
import { markdownToHtml } from "./markdown.js";
import { escapeHtml, htmlToText } from "./render-email.js";

// What the web archive shows of an issue for paid subscribers: its first words as plain, escaped text, so nothing of the
// rest (markup, images, links) can come along. The full issue is only in the email.
const TEASER_CHARS = 320;
const MIN_TEASER_CHARS = 80;
const MAX_PARAGRAPHS = 2;
// However short the issue, a teaser is never most of it.
const MAX_SHARE = 0.6;

function toPlainText(campaign) {
	if (campaign.format === "html") return htmlToText(campaign.html);
	return htmlToText(campaign.format === "rich" ? filterAudienceBlocks(cleanRichHtml(expandHtmlSnippets(campaign.html))).html : markdownToHtml(campaign.markdown));
}

function cutAtWord(text, limit) {
	if (text.length <= limit) return text;
	const cut = text.slice(0, limit);
	return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), limit / 2)).replace(/[\s,;:.-]+$/, "")}…`;
}

// A gated issue (lib/popup-rules.js) shows its writer's share of the text instead, up to a size of its own.
export function makeTeaser(campaign, { share = 0.4, maxChars = TEASER_CHARS, maxParagraphs = MAX_PARAGRAPHS, maxShare = MAX_SHARE } = {}) {
	const paragraphs = toPlainText(campaign)
		.split(/\n{2,}/)
		.map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
		.filter(Boolean);
	const total = paragraphs.join(" ").length;
	const budget = Math.min(Math.max(MIN_TEASER_CHARS, Math.min(maxChars, Math.floor(total * share))), Math.floor(total * maxShare));
	const taken = [];
	let length = 0;
	for (const paragraph of paragraphs.slice(0, maxParagraphs)) {
		const room = budget - length;
		if (room < 20) break;
		taken.push(cutAtWord(paragraph, room));
		length += paragraph.length;
		if (paragraph.length > room) break;
	}
	return taken.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("");
}
