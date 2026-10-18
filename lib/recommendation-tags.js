// The merge tag that puts the newsletter's recommendations in an issue: a small block of links to the signup pages, with
// nothing ticked or subscribed. Filled in where the issue is rendered: the email (lib/sending-rules.js), the web version
// (lib/archive-content.js) and the RSS feed.
export const RECOMMENDATIONS_TAG = "{{recommendations}}";
const TAG = /\{\{\s*recommendations\s*\}\}/gi;
// Markdown and the editor wrap a tag standing alone in a paragraph, which a block can't sit in.
const ALONE_IN_PARAGRAPH = /<p\b[^>]*>\s*\{\{\s*recommendations\s*\}\}\s*<\/p>/gi;
const HEADING = "Recommended newsletters";

export function hasRecommendationsTag(text) {
	return /\{\{\s*recommendations\s*\}\}/i.test(String(text ?? ""));
}

function escape(value) {
	return String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

// Names and pitches are other people's words, and the email fills merge tags in after this: a name can't carry one.
function plain(value) {
	return String(value ?? "").replaceAll("{{", "{ {").replaceAll("}}", "} }");
}

// items: { name, pitch, url } each. style "inline": a box with its styles inline, for emails and HTML issues. "plain": bare
// elements the archive page styles itself, since it strips style attributes. "text": the plain-text email.
export function buildRecommendationsBlock(items, style = "inline") {
	if (!items?.length) return "";
	if (style === "text") {
		return [HEADING, ...items.map(({ name, pitch, url }) => `- ${plain(name)}: ${plain(pitch)}\n  ${url}`)].join("\n");
	}
	if (style === "plain") {
		const rows = items.map(
			({ name, pitch, url }) => `<li><a href="${escape(url)}"><strong>${escape(plain(name))}</strong></a>: ${escape(plain(pitch))}</li>`
		);
		return `<h3>${HEADING}</h3><ul>${rows.join("")}</ul>`;
	}
	const rows = items.map(
		({ name, pitch, url }) =>
			`<p style="margin:0 0 12px;"><a href="${escape(url)}" style="font-weight:600;">${escape(plain(name))}</a><br>${escape(plain(pitch))}</p>`
	);
	return `<div style="margin:24px 0;padding:16px 20px;border-radius:8px;background:#f4f4f5;"><p style="margin:0 0 12px;"><strong>${HEADING}</strong></p>${rows.join("")}</div>`;
}

// items: null leaves the tag as written (an export keeps the source); an empty list removes it.
export function fillRecommendationsTag(text, items, style = "inline") {
	if (items === null || items === undefined || !hasRecommendationsTag(text)) return String(text ?? "");
	const block = buildRecommendationsBlock(items, style);
	return String(text)
		.replace(ALONE_IN_PARAGRAPH, () => block)
		.replace(TAG, () => block);
}
