import { beforeLastTagEnd, cleanRichHtml, keepSafeUrls } from "./clean-html.js";
import { markdownToHtml } from "./markdown.js";
import { makeTeaser } from "./paywall.js";
import { UNSUBSCRIBE_PLACEHOLDER, renderEmail, withResponsiveImages } from "./render-email.js";
import { fillCommentTags } from "./comment-tags.js";
import { fillReferralTags } from "./referral-tags.js";
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
// referralLink: where the referral merge tags point, as readers of the web aren't subscribers with a link of their own
// ("{{referral_link}}" becomes this, "{{referral_count}}" 0). null leaves the tags as written. commentLink: the same for
// "{{comment_link}}", the page's own comments by default; null leaves it, which an export's text does with both.
export function renderIssueBody(campaign, { referralLink = "#", commentLink = referralLink === null ? null : "#comments" } = {}) {
	const fill = (text) => fillCommentTags(referralLink === null ? text : fillReferralTags(text, { link: referralLink, count: 0 }), { link: commentLink });
	// A paid issue's page is a teaser; the rest is in the email (lib/paywall.js).
	if (campaign.audience === "paid") return { kind: "paywall", html: makeTeaser(campaign) };
	if (campaign.format === "rich") return article(cleanRichHtml(fill(campaign.html)));
	if (campaign.format !== "html") return article(cleanRichHtml(fill(markdownToHtml(campaign.markdown))));

	const { html } = renderEmail({
		format: "html",
		html: fill(campaign.html),
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
export function getIssueContentHtml(campaign, options) {
	const { kind, html } = renderIssueBody(campaign, options);
	if (kind === "article") return html;
	const body = /<body\b[^>]*>([\s\S]*)<\/body\s*>/i.exec(html)?.[1] ?? html;
	return sanitizeIssueHtml(body);
}
