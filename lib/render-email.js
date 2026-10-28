import { filterAudienceBlocks } from "./audience-blocks.js";
import { getNewsletterTiers } from "./tier-rules.js";
import { expandHtmlSnippets } from "./html-snippets.js";
import { getReaderText, getReaderLanguage } from "./reader-languages.js";
import { getBrand } from "./brand.js";
import { calloutExtension, inlineCalloutStyles } from "./callouts.js";
import { beforeLastTagEnd, cleanRichHtml, replaceElements } from "./clean-html.js";
import {
	emailPaywallMarker,
	emailUpgradeCard,
	POLL_LINK_PATTERN,
	renderEmailBlocks,
	renderFootnotes,
	splitAtPaywall,
	styleEmailTables,
} from "./editor-blocks.js";
import { createMarkdownParser } from "./markdown.js";
import { escapeHtml } from "./escape-html.js";
import { fillMergeTags } from "./merge-tags.js";
import { addSectionIcons } from "./section-icons.js";
import { SENT_WITH_TEXT, SENT_WITH_URL } from "./site.js";

export const UNSUBSCRIBE_PLACEHOLDER = "{{unsubscribe_url}}";
// A paid reader's billing link goes in after the links are tracked, like the unsubscribe link: it is theirs alone.
export const MANAGE_URL_PLACEHOLDER = "{{manage_billing_url}}";
// The reader's preference center (lib/preferences.js), also theirs alone: filled in after the links are tracked.
export const PREFERENCES_URL_PLACEHOLDER = "{{preferences_url}}";
// Generated HTML prints these instead of its own copy, so editing the campaign changes the email too.
export const SUBJECT_PLACEHOLDER = "{{subject}}";
export const PREVIEW_TEXT_PLACEHOLDER = "{{preview_text}}";
// Parts only the email needs, like a headline the archive page already shows. One can't contain an
// element with its own tag name.
const EMAIL_ONLY_ELEMENT = {
	start: /<([a-z][a-z0-9]*)\b[^>]*>/gi,
	end: /<\/([a-z][a-z0-9]*)>/gi,
	accepts: ([tag]) => /\sdata-email-only\b/i.test(tag),
};
const HIDDEN_ELEMENT = { start: /<(style|script|head)/gi, end: /<\/(style|script|head)>/gi };
const PREHEADER_ELEMENT = { start: /<(div)\b[^>]*>/gi, end: /<\/(div)>/gi, accepts: ([tag]) => /\bdata-preheader\b/i.test(tag) };
const LINK_HREF_PATTERN = /^<a\s[^>]*href="([^"]+)"/i;
const LINK_ELEMENT = { start: /<(a)\s[^>]*>/gi, end: /<\/(a)>/gi, accepts: ([tag]) => LINK_HREF_PATTERN.test(tag), replace: linkText };
const FONT_STACK = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const parseMarkdown = createMarkdownParser(calloutExtension({ isEmail: true }));

export { escapeHtml };

function stripTags(html) {
	return beforeLastTagEnd(html, (part) => part.replace(/<[^>]+>/g, ""));
}

function linkText([tag], label) {
	const href = LINK_HREF_PATTERN.exec(tag)[1];
	const text = stripTags(label).trim();
	return !text || text === href ? href : `${text} (${href})`;
}

export function htmlToText(html) {
	const visible = beforeLastTagEnd(replaceElements(String(html ?? ""), HIDDEN_ELEMENT), (part) =>
		replaceElements(replaceElements(part, PREHEADER_ELEMENT), LINK_ELEMENT)
	);
	const blocks = visible
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|h[1-6]|li|tr|table|blockquote)>/gi, "\n\n");
	return stripTags(beforeLastTagEnd(blocks, (part) => part.replace(/<li[^>]*>/gi, "• ")))
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		// Starting only at the first space of a run, so a long run not ending a line is read once.
		.replace(/(?<![ \t])[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

// The editor saves "<p></p>" for an empty document, so content means words, a picture or a block that shows something.
export function hasContent(body) {
	return /<img\b|\sdata-(embed|button|poll|file|rss|html|sponsorship)\b/i.test(body ?? "") || htmlToText(body).length > 0;
}

// Some clients drop <style>, so editor content carries its layout inline. Images are centered like
// on the archive, and the paragraph the editor puts inside each list item loses its margin. Blocks become their
// tables last, so their own pictures keep their own styles.
function styleRichPart(html, accent, contentsLabel) {
	const styled = inlineCalloutStyles(styleEmailTables(html))
		.replace(/<pre>/g, '<pre style="white-space:pre-wrap;word-break:break-word;background:#f4f4f5;padding:16px;border-radius:8px;">')
		.replaceAll("<li><p>", '<li><p style="margin:0;">')
		.replace(
			/<img\b/gi,
			'<img style="display:block;max-width:100%;height:auto;margin:24px auto;border-radius:8px;"'
		);
	return renderEmailBlocks(styled, { accent, contentsLabel });
}

// readerTier: "free" ends the email at the writer's paywall break with an upgrade card, "paid" reads on past it, and
// nothing (a test email, the editor's preview) shows both parts with a line where the paid part starts.
function richEmailBody(html, { accent, readerTier, readerTierId, tiers, upgradeUrl, contentsLabel }) {
	const { before, after, hasBreak } = splitAtPaywall(filterAudienceBlocks(cleanRichHtml(expandHtmlSnippets(html)), { readerTier, readerTierId, tiers, previewAll: readerTier === null }).html);
	if (hasBreak && readerTier === "free") return renderFootnotes(styleRichPart(before, accent, contentsLabel)) + emailUpgradeCard({ upgradeUrl, accent });
	const marker = hasBreak && readerTier !== "paid" ? emailPaywallMarker() : "";
	return renderFootnotes(styleRichPart(before + marker + after, accent, contentsLabel));
}

// transactionalReason: an email about something the reader did (an order), which has no unsubscribe link: this line says
// why it came. manageBillingUrl: a paid subscriber's link to their billing page. commentsUrl: this reader's link to the
// issue's comments, when the newsletter has them on.
function footerHtml({ newsletter, unsubscribeUrl, transactionalReason, manageBillingUrl, commentsUrl, preferencesUrl, sentWith = false }) {
	const t = getReaderText(newsletter);
	const address = newsletter?.postalAddress
		? `<br>${escapeHtml(newsletter.postalAddress)}`
		: "";
	if (transactionalReason) {
		return `<tr><td style="padding:32px 0 0;font-size:12px;line-height:1.6;color:#71717a;border-top:1px solid #e4e4e7;">
${escapeHtml(transactionalReason)}${address}
</td></tr>`;
	}
	const discuss = commentsUrl ? `<a href="${escapeHtml(commentsUrl)}" style="color:#71717a;text-decoration:underline;">${escapeHtml(t("Discuss this issue"))}</a> · ` : "";
	const manage = manageBillingUrl
		? `<a href="${escapeHtml(manageBillingUrl)}" style="color:#71717a;text-decoration:underline;">${escapeHtml(t("Manage your subscription"))}</a> · `
		: "";
	const preferences = preferencesUrl ? `<a href="${escapeHtml(preferencesUrl)}" style="color:#71717a;text-decoration:underline;">${escapeHtml(t("Update your preferences"))}</a> · ` : "";
	return `<tr><td style="padding:32px 0 0;font-size:12px;line-height:1.6;color:#71717a;border-top:1px solid #e4e4e7;">
${escapeHtml(t("You're receiving this because you subscribed to {name}.", { name: newsletter?.name || "this newsletter" })).replace(/\.$/, "")}.<br>
${discuss}${manage}${preferences}<a href="${unsubscribeUrl}" style="color:#71717a;text-decoration:underline;">${escapeHtml(t("Unsubscribe"))}</a>${address}
</td></tr>${sentWith ? `\n${sentWithHtml()}` : ""}`;
}

// A Free account's "Sent with FlockStack" link, a line of its own under the footer (lib/free-plan.js).
function sentWithHtml() {
	return `<tr><td style="padding:12px 0 0;font-size:12px;line-height:1.6;color:#a1a1aa;"><a href="${SENT_WITH_URL}" data-sent-with style="color:#a1a1aa;text-decoration:underline;">${SENT_WITH_TEXT}</a></td></tr>`;
}

function footerText({ newsletter, unsubscribeUrl, transactionalReason, manageBillingUrl, commentsUrl, preferencesUrl, sentWith }) {
	const t = getReaderText(newsletter);
	if (transactionalReason) return ["—", transactionalReason, newsletter?.postalAddress].filter(Boolean).join("\n");
	return [
		"—",
		t("You're receiving this because you subscribed to {name}.", { name: newsletter?.name || "this newsletter" }),
		commentsUrl && `${t("Discuss this issue")}: ${commentsUrl}`,
		manageBillingUrl && `${t("Manage your subscription")}: ${manageBillingUrl}`,
		preferencesUrl && `${t("Update your preferences")}: ${preferencesUrl}`,
		`${t("Unsubscribe")}: ${unsubscribeUrl}`,
		newsletter?.postalAddress,
		sentWith && `${SENT_WITH_TEXT}: ${SENT_WITH_URL}`,
	]
		.filter(Boolean)
		.join("\n");
}

function preheaderHtml(previewText) {
	if (!previewText) return "";
	// Padding characters stop clients from pulling body text into the inbox preview.
	return `<div style="display:none;max-height:0;overflow:hidden;opacity:0;" data-preheader>${escapeHtml(previewText)}${"&#847;&zwnj;&nbsp;".repeat(40)}</div>`;
}

// "Listen to this issue (12 min)" above the issue, when its writer ticked it and the audio is ready: the link opens the
// player on the issue's web page.
function listenLinkHtml({ listen, accent = "#18181b" }) {
	return `<a href="${escapeHtml(listen.url)}" style="color:${escapeHtml(accent)};text-decoration:underline;font-weight:600;">Listen to this issue (${Math.max(1, Math.round(listen.minutes))} min)</a>`;
}

function readOnlineLink(webUrl) {
	return `<a href="${escapeHtml(webUrl)}" style="color:#a1a1aa;text-decoration:none;">Read online</a>`;
}

// "Share: X · LinkedIn · Facebook · Email" beside the read online link, when the issue has share buttons (lib/share-links.js).
function shareLinksHtml({ shareLinks, label }) {
	if (!shareLinks?.length) return "";
	const links = shareLinks.map(({ href, label: name }) => `<a href="${escapeHtml(href)}" style="color:#a1a1aa;text-decoration:none;">${escapeHtml(name)}</a>`);
	return `<span style="color:#a1a1aa;">${escapeHtml(label)}:</span> ${links.join(" · ")}`;
}

function topLinksHtml({ webUrl, shareLinks, shareLabel }) {
	return [shareLinksHtml({ shareLinks, label: shareLabel }), webUrl && readOnlineLink(webUrl)].filter(Boolean).join(" &nbsp;|&nbsp; ");
}

function fillFields(html, { subject, previewText }) {
	return html
		.replaceAll(SUBJECT_PLACEHOLDER, escapeHtml(subject))
		.replaceAll(PREVIEW_TEXT_PLACEHOLDER, escapeHtml(previewText));
}

// Outlook's Word engine and some webmail drop the <style> block, so a newsletter that chose an accent or fonts also
// carries them inline on the links and headings the writer made.
function inlineBrandStyles(html, brand) {
	return beforeLastTagEnd(html, (part) =>
		part
			.replace(/<a\b(?![^>]*\sstyle=)/gi, `<a style="color:${brand.linkOnLight};"`)
			.replace(/<(h[1-3])\b(?![^>]*\sstyle=)/gi, `<$1 style="font-family:${brand.fonts.heading};color:#09090b;"`)
	);
}

// The newsletter's logo and name, then its header image, above the issue. Tables only, and the name is text beside the
// logo: a client that darkens the email on its own can hide a transparent logo, never the words. The publisher line
// ("by QuoteSweep") goes under the name.
function mastheadHtml({ brand, name, webUrl }) {
	const publisher = brand.publisher ? `<br><span style="font-size:13px;font-weight:400;color:#71717a;">${escapeHtml(brand.publisher)}</span>` : "";
	const link = (content) => (webUrl ? `<a href="${escapeHtml(webUrl)}" style="color:#09090b;text-decoration:none;">${content}</a>` : content);
	const logo = brand.hasEmailLogo
		? `<tr><td style="padding:0 0 24px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${
				brand.logoUrl
					? `<td width="40" valign="middle" style="padding:0 12px 0 0;">${link(`<img src="${escapeHtml(brand.logoUrl)}" width="40" height="40" alt="" style="display:block;width:40px;height:40px;border:0;border-radius:8px;">`)}</td>`
					: ""
			}<td valign="middle" style="font-family:${brand.fonts.heading};font-size:20px;font-weight:700;line-height:1.2;color:#09090b;">${link(escapeHtml(name))}${publisher}</td></tr></table></td></tr>\n`
		: "";
	const header = brand.headerUrl
		? `<tr><td style="padding:0 0 24px;">${link(`<img src="${escapeHtml(brand.headerUrl)}" width="560" alt="${escapeHtml(name)}" style="display:block;width:100%;max-width:560px;height:auto;border:0;border-radius:8px;">`)}</td></tr>\n`
		: "";
	return logo + header;
}

// The issue's share card at the top (lib/issue-card.js): the full column's width, its title as the alt text, so with images
// off the email still reads from its subject down.
function issueCardHtml(card) {
	if (!card) return "";
	return `<tr><td style="padding:0 0 24px;"><img src="${escapeHtml(card.url)}" width="${card.width}" height="${card.height}" alt="${escapeHtml(card.alt)}" style="display:block;width:100%;max-width:${card.width}px;height:auto;border:0;border-radius:8px;"></td></tr>\n`;
}

// A section heading's icon (24 by 24, its title as alt text) before the heading's own words, which read alone with images off.
function sectionIconHtml(url, title) {
	return `<img src="${escapeHtml(url)}" width="24" height="24" alt="${escapeHtml(title)}" style="margin:0 8px 0 0;border:0;border-radius:0;vertical-align:-4px;">`;
}

function wrapMarkdownBody({ bodyHtml, subject, previewText, footer, webUrl, brand, name, listen, shareLinks, shareLabel, issueCard = null, language = "en" }) {
	const headingFont = brand.isCustom ? `font-family: ${brand.fonts.heading}; ` : "";
	return `<!DOCTYPE html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(subject)}</title>
<style>
:root { color-scheme: light; }
.body a { color: ${brand.linkOnLight}; }
.body img { max-width: 100%; height: auto; border-radius: 8px; }
.body h1, .body h2, .body h3 { ${headingFont}line-height: 1.3; margin: 32px 0 12px; color: #09090b; }
.body p, .body ul, .body ol { margin: 0 0 16px; }
.body blockquote { margin: 0 0 16px; padding-left: 16px; border-left: 3px solid #e4e4e7; color: #52525b; }
.body code { font-family: ui-monospace, Menlo, monospace; font-size: 14px; background: #f4f4f5; padding: 2px 4px; border-radius: 4px; }
.body hr { border: 0; border-top: 1px solid #e4e4e7; margin: 32px 0; }
</style>
</head>
<body style="margin:0;padding:0;background:#ffffff;">
${preheaderHtml(previewText)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;">
<tr><td align="center" style="padding:32px 20px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;font-family:${brand.fonts.body};font-size:16px;line-height:1.65;color:#27272a;">
${webUrl ? `<tr><td align="right" style="padding:0 0 24px;font-size:12px;line-height:1.4;">${topLinksHtml({ webUrl, shareLinks, shareLabel })}</td></tr>\n` : ""}${mastheadHtml({ brand, name, webUrl })}${issueCardHtml(issueCard)}${listen ? `<tr><td style="padding:0 0 20px;font-size:15px;line-height:1.4;">${listenLinkHtml({ listen, accent: brand.linkOnLight })}</td></tr>\n` : ""}<tr><td class="body">${bodyHtml}</td></tr>
${footer}
</table>
</td></tr>
</table>
</body>
</html>`;
}

// Generated HTML (an issue built by another app) keeps its own design and gets the footer appended.
function withFooter({ html, newsletter, unsubscribeUrl, previewText, webUrl, listen, shareLinks, transactionalReason, manageBillingUrl, commentsUrl, preferencesUrl, sentWith }) {
	const wrap = (rows) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:0 20px 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;font-family:${FONT_STACK};">${rows}</table></td></tr></table>`;
	const footer = wrap(footerHtml({ newsletter, unsubscribeUrl, transactionalReason, manageBillingUrl, commentsUrl, preferencesUrl, sentWith }));
	// Its column width is unknown, so the link sits centered above it.
	const readOnline = webUrl
		? `<div style="padding:12px 16px 0;text-align:center;font-family:${FONT_STACK};font-size:12px;line-height:1.4;">${topLinksHtml({ webUrl, shareLinks, shareLabel: "Share" })}</div>`
		: "";
	const listenLine = listen
		? `<div style="padding:12px 16px 0;text-align:center;font-family:${FONT_STACK};font-size:14px;line-height:1.4;">${listenLinkHtml({ listen })}</div>`
		: "";
	const top = `${preheaderHtml(previewText)}${readOnline}${listenLine}`;
	// Only a <body before the last ">" can match; when one does, so does the first, where the replace stops.
	const hasBody = /<body[^>]*>/i.test(html.slice(0, html.lastIndexOf(">") + 1));
	const withTop = hasBody ? html.replace(/<body[^>]*>/i, (match) => `${match}${top}`) : `${top}${html}`;
	// An issue with its own unsubscribe link has its own footer, but the Free plan's link still goes under it.
	const closing = withTop.includes(UNSUBSCRIBE_PLACEHOLDER) ? (sentWith ? wrap(sentWithHtml()) : "") : footer;
	if (!closing) return withTop;
	return /<\/body>/i.test(withTop) ? withTop.replace(/<\/body>/i, `${closing}</body>`) : `${withTop}${closing}`;
}

// A preview has no reader: its unsubscribe and vote links go nowhere.
export function withPreviewLinks(html) {
	return html.replaceAll(UNSUBSCRIBE_PLACEHOLDER, "#").replaceAll(PREFERENCES_URL_PLACEHOLDER, "#").replace(POLL_LINK_PATTERN, "#");
}

// HTML issues built elsewhere may rely on their own site's CSS to keep images inside the column.
export function withResponsiveImages(html) {
	const style = "<style>img{max-width:100%;height:auto}</style>";
	return beforeLastTagEnd(html, (part) => part.replace(/<head([^>]*)>/i, (head) => `${head}${style}`));
}

export function renderEmail({
	format = "markdown",
	markdown: source = "",
	html = "",
	subject = "",
	previewText = "",
	newsletter,
	unsubscribeUrl = UNSUBSCRIBE_PLACEHOLDER,
	// The issue's archive page, linked at the top of the email.
	webUrl = null,
	// Public archive pages: same design, no subscriber footer.
	isWebVersion = false,
	transactionalReason = "",
	manageBillingUrl = "",
	commentsUrl = "",
	// The footer's link to the preference center: the placeholder, filled in for each reader.
	preferencesUrl = "",
	// The reader's tier for the paywall break ("free" or "paid"), and where a free reader upgrades.
	readerTier = null,
	readerTierId = null,
	upgradeUrl = "",
	// A Free account's "Sent with FlockStack" link under the footer (lib/free-plan.js showsSentWithLink).
	sentWith = false,
	// Where a newsletter's /path images are served, for the logo and header in a sent email (lib/brand.js).
	assetBase = "",
	// { url, minutes }: a "Listen to this issue" link above the issue (lib/audio.js), for the issue's audio version.
	listen = null,
	// [{ label, href }]: share buttons beside the read online link (lib/share-links.js), for an email whose issue has a page.
	shareLinks = [],
	// { url, alt, width, height }: the issue's share card at the top of the email (lib/issue-card.js getEmailCard).
	issueCard = null,
	// key => the absolute address of a section icon (lib/issue-card.js getEmailIconUrl): set, a sectioned issue's headings get theirs.
	sectionIconUrl = null,
}) {
	const brand = getBrand(newsletter, { assetBase });
	const readOnlineUrl = isWebVersion ? null : webUrl;
	// A page has no reader, so every merge tag prints its fallback.
	const fillPublic = (value) => (isWebVersion ? fillMergeTags(value, null, { escape: escapeHtml }) : value);
	if (format === "html") {
		const filled = fillPublic(fillFields(html, { subject, previewText }));
		const rendered = isWebVersion
			? beforeLastTagEnd(filled, (part) => replaceElements(part, EMAIL_ONLY_ELEMENT))
			: withFooter({ html: filled, newsletter, unsubscribeUrl, previewText, webUrl: readOnlineUrl, listen: isWebVersion ? null : listen, shareLinks: isWebVersion ? [] : shareLinks, transactionalReason, manageBillingUrl, commentsUrl, preferencesUrl, sentWith });
		const text = htmlToText(rendered.replaceAll(UNSUBSCRIBE_PLACEHOLDER, unsubscribeUrl));
		return { html: rendered, text, bytes: byteLength(rendered) };
	}

	const written = fillPublic(format === "rich" ? richEmailBody(html, { accent: brand.accent, readerTier, readerTierId, tiers: getNewsletterTiers(newsletter), upgradeUrl, contentsLabel: getReaderText(newsletter)("Contents") }) : parseMarkdown(source));
	const styled = brand.isCustom ? inlineBrandStyles(written, brand) : written;
	const bodyHtml = sectionIconUrl && !isWebVersion ? addSectionIcons(styled, (key, title) => sectionIconHtml(sectionIconUrl(key), title)) : styled;
	const footer = isWebVersion ? "" : footerHtml({ newsletter, unsubscribeUrl, transactionalReason, manageBillingUrl, commentsUrl, preferencesUrl, sentWith });
	const rendered = wrapMarkdownBody({ language: getReaderLanguage(newsletter), bodyHtml, subject, previewText, footer, webUrl: readOnlineUrl, listen: isWebVersion ? null : listen, shareLinks: isWebVersion ? [] : shareLinks, shareLabel: "Share", issueCard: isWebVersion ? null : issueCard, brand: isWebVersion ? { ...brand, hasEmailLogo: false, headerUrl: "" } : brand, name: newsletter?.name || "" });
	const readOnlineText = `${readOnlineUrl ? `Read online: ${readOnlineUrl}\n\n` : ""}${listen && !isWebVersion ? `Listen to this issue (${Math.max(1, Math.round(listen.minutes))} min): ${listen.url}\n\n` : ""}`;
	const text = isWebVersion
		? htmlToText(styled)
		: `${readOnlineText}${htmlToText(styled)}\n\n${footerText({ newsletter, unsubscribeUrl, transactionalReason, manageBillingUrl, commentsUrl, preferencesUrl, sentWith })}`;
	return { html: rendered, text, bytes: byteLength(rendered) };
}

function byteLength(value) {
	return new TextEncoder().encode(value).length;
}
