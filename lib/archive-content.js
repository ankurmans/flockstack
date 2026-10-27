import { filterAudienceBlocks } from "./audience-blocks.js";
import { expandHtmlSnippets } from "./html-snippets.js";
import { beforeLastTagEnd, cleanRichHtml, keepSafeUrls } from "./clean-html.js";
import { DEFAULT_ACCENT, renderFootnotes, renderWebBlocks, splitAtPaywall } from "./editor-blocks.js";
import { markdownToHtml } from "./markdown.js";
import { makeTeaser } from "./paywall.js";
import { PREFERENCES_URL_PLACEHOLDER, UNSUBSCRIBE_PLACEHOLDER, renderEmail, withResponsiveImages } from "./render-email.js";
import { fillRecommendationsTag } from "./recommendation-tags.js";
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

// Inline HTML becomes part of the page, so it goes through the sanitizer, however it was stored. The editor's blocks
// become their markup after it (lib/editor-blocks.js builds it from checked values only): frames for embeds, links
// for files and polls, numbered footnotes. What follows a paywall break isn't on the page everyone gets: it carries the
// upgrade card, and a signed-in paid reader's browser asks for the whole issue (isUnlocked, lib/reader-access.js).
function article(html, { accent = DEFAULT_ACCENT, pollUrl, contentsLabel, isUnlocked = false } = {}) {
	const { before, after, hasBreak } = splitAtPaywall(html);
	const isGated = hasBreak && !isUnlocked;
	const safe = sanitizeIssueHtml(prioritizeImages(isGated ? before : before + after));
	const rendered = renderFootnotes(renderWebBlocks(safe, { accent, pollUrl, contentsLabel }), { mode: "web" });
	return isGated ? { kind: "paywall", isPartial: true, html: rendered } : { kind: "article", html: rendered };
}

// A custom page: the same editor, cleaned and shown like an issue, with no paywall, polls or merge tags. A paywall break
// a writer pasted in is ignored: a page is for everyone.
export function renderPageBody(html, { accent = DEFAULT_ACCENT, contentsLabel } = {}) {
	const { before, after } = splitAtPaywall(cleanRichHtml(expandHtmlSnippets(html)));
	const safe = sanitizeIssueHtml(prioritizeImages(before + after));
	return renderFootnotes(renderWebBlocks(safe, { accent, pollUrl: () => "#", contentsLabel }), { mode: "web" });
}

// Editor and Markdown issues take the archive's typography. HTML issues, including every one sent
// through the API, keep their own design in a sandboxed frame, which measures its height once pictures
// load, so nothing in it loads lazily.
// referralLink: where the referral merge tags point, as readers of the web aren't subscribers with a link of their own
// ("{{referral_link}}" becomes this, "{{referral_count}}" 0). null leaves the tags as written. commentLink: the same for
// "{{comment_link}}", the page's own comments by default; null leaves it, which an export's text does with both.
// recommendations: the newsletter's live ones ({ name, pitch, url }) for {{recommendations}}; none removes the tag, null leaves it.
// accent: the newsletter's color for buttons. pollUrl(id, index): where a web reader votes, the archive host's /poll.
// isUnlocked: the reader is a paid subscriber, so a paid issue and what follows a paywall break show whole.
export function renderIssueBody(
	campaign,
	{ referralLink = "#", commentLink = referralLink === null ? null : "#comments", recommendations = [], accent, pollUrl, contentsLabel, isUnlocked = false, readerTier = isUnlocked ? "paid" : "free", readerTierId = null, tiers = [], previewAll = false } = {}
) {
	const hasAudienceVariants = campaign.format === "rich" && /\sdata-access\b/i.test(campaign.html ?? "");
	const visibility = campaign.format === "rich" ? filterAudienceBlocks(cleanRichHtml(expandHtmlSnippets(campaign.html)), { readerTier, readerTierId, tiers, previewAll }) : null;
	if (visibility) campaign = { ...campaign, html: visibility.html };
	const fillReferral = (text) => (referralLink === null ? text : fillReferralTags(text, { link: referralLink, count: 0 }));
	const fillComment = (text) => fillCommentTags(text, { link: commentLink });
	// The archive page strips style attributes, so only an HTML issue, which keeps its own design in a frame, gets the styled box.
	// A page has no reader, so the preference center's link goes to the signup form.
	const fillAll = (style) => (text) => fillRecommendationsTag(fillComment(fillReferral(text.replaceAll(PREFERENCES_URL_PLACEHOLDER, "#subscribe"))), recommendations, style);
	const fill = fillAll("plain");
	// A paid issue's page is a teaser for everyone else (lib/paywall.js); a paid reader's session shows the rest.
	if (campaign.audience === "paid" && !isUnlocked) return { kind: "paywall", html: makeTeaser(campaign) };
	if (campaign.format === "rich") {
		const body = article(cleanRichHtml(fill(campaign.html)), { accent, pollUrl, contentsLabel, isUnlocked });
		return visibility.hiddenPaid && !previewAll ? { ...body, kind: "paywall", isPartial: true, hasAudienceVariants } : { ...body, ...(hasAudienceVariants && { hasAudienceVariants }) };
	}
	if (campaign.format !== "html") return article(cleanRichHtml(fill(markdownToHtml(campaign.markdown))), { accent, pollUrl, contentsLabel, isUnlocked });

	const { html } = renderEmail({
		format: "html",
		html: fillAll("inline")(campaign.html),
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
	// Feeds and exports take no frames: an embed keeps its link.
	if (kind === "article" || kind === "paywall") return sanitizeIssueHtml(html);
	const body = /<body\b[^>]*>([\s\S]*)<\/body\s*>/i.exec(html)?.[1] ?? html;
	return sanitizeIssueHtml(body);
}
