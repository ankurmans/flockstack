import { beforeLastTagEnd, cleanRichHtml, keepSafeUrls } from "./clean-html.js";
import { markdownToHtml } from "./markdown.js";
import { UNSUBSCRIBE_PLACEHOLDER, renderEmail, withResponsiveImages } from "./render-email.js";
import { sanitizeIssueHtml } from "./safe-html.js";

// The first picture is the hero, so it loads right away; the rest wait until they scroll into view.
function prioritizeImages(html) {
	let index = 0;
	return html.replace(/<img\b([^>]*?)\/?>/gi, (_, attributes) => {
		index += 1;
		const loading = index === 1 ? ' fetchpriority="high"' : ' loading="lazy"';
		return `<img${attributes}${loading} decoding="async">`;
	});
}

// Inline HTML becomes part of the page, so it goes through the sanitizer last, however it was stored.
function article(html) {
	return { kind: "article", html: sanitizeIssueHtml(prioritizeImages(html)) };
}

// Editor and Markdown issues take the archive's typography. HTML issues, including every one sent
// through the API, keep their own design in a sandboxed frame, which measures its height once pictures
// load, so nothing in it loads lazily.
export function renderIssueBody(campaign) {
	if (campaign.format === "rich") return article(cleanRichHtml(campaign.html));
	if (campaign.format !== "html") return article(cleanRichHtml(markdownToHtml(campaign.markdown)));

	const { html } = renderEmail({
		format: "html",
		html: campaign.html,
		subject: campaign.subject,
		previewText: campaign.previewText,
		isWebVersion: true,
	});
	const framed = beforeLastTagEnd(keepSafeUrls(withResponsiveImages(html)), (part) =>
		part.replace(/<head([^>]*)>/i, (head) => `${head}<base target="_blank">`)
	);
	return { kind: "frame", html: framed.replaceAll(UNSUBSCRIBE_PLACEHOLDER, "#") };
}

// Just the issue's content, for places that have no frame to keep its design in (the RSS feed, an export's Markdown): an
// HTML issue loses its head, styles and scripts and keeps the body's text, links and pictures.
export function getIssueContentHtml(campaign) {
	const { kind, html } = renderIssueBody(campaign);
	if (kind === "article") return html;
	const body = /<body\b[^>]*>([\s\S]*)<\/body\s*>/i.exec(html)?.[1] ?? html;
	return sanitizeIssueHtml(body);
}
