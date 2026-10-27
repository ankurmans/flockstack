import { getReaderText } from "./reader-languages.js";
import crypto from "node:crypto";
import { getIssueContentHtml } from "./archive-content.js";
import { getPollVoteUrl } from "./subscriber-links.js";
import { getIssueAuthor } from "./archive-author.js";
import { getArchiveUrls } from "./archive-hosts.js";
import { getIssueDate } from "./archive-issues.js";
import { getAppUrl } from "./config.js";
import { makeTeaser } from "./paywall.js";
import { getGateTeaserOptions, getPopupSettings, isGatedIssue } from "./popup-rules.js";
import { escapeHtml, htmlToText } from "./render-email.js";

export const FEED_ISSUE_LIMIT = 30;
const EXCERPT_LENGTH = 280;
// XML 1.0 has no place for most control characters, so one in a subject would make the whole feed unreadable.
const INVALID_XML_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

// Which issues the feed shows: an issue for paid readers (audience "paid") or with an access level other than "free"
// stays out, so paid issues never leak here. A caller can pass its own filter to buildFeed.
export function isFreeIssue(issue) {
	return issue.audience !== "paid" && (!issue.access || issue.access === "free");
}

export function escapeXml(value) {
	return String(value ?? "")
		.replace(INVALID_XML_CHARACTERS, "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

// "]]>" ends a CDATA section, so it's split across two.
function cdata(value) {
	return `<![CDATA[${String(value ?? "").replace(INVALID_XML_CHARACTERS, "").replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;
}

// RFC 822 dates, as RSS 2.0 wants: "Sun, 18 Oct 2026 09:30:00 GMT".
export function toRssDate(date) {
	return new Date(date).toUTCString();
}

function toAbsoluteUrl(url, appUrl) {
	return url?.startsWith("/") ? `${appUrl}${url}` : url;
}

function getExcerpt(issue, bodyHtml) {
	const text = issue.previewText?.trim() || htmlToText(bodyHtml).replace(/\s+/g, " ");
	return text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH - 1).trimEnd()}…` : text;
}

// A stable ID: it never changes with the newsletter's address, so moving the archive to its own domain doesn't make
// every reader show all the issues as new.
export function getFeedGuid(issue) {
	return `flockstack:${String(issue._id)}`;
}

// preview: a gated issue's beginning (lib/popup-rules.js), which is all the feed has of it.
function buildItem({ issue, newsletter, urls, appUrl, recommendations, preview }) {
	const url = urls.absolutePost(issue.archiveSlug);
	const bodyHtml = preview
		? `${preview}<p><a href="${escapeHtml(url)}">Subscribe to read the rest of this issue</a></p>`
		: getIssueContentHtml(issue, {
				referralLink: urls.siteIndex,
				contentsLabel: getReaderText(newsletter)("Contents"),
				commentLink: `${url}#comments`,
				recommendations,
				pollUrl: (pollId, option) => getPollVoteUrl(null, newsletter, { pollId, option }),
			});
	const date = getIssueDate(issue);
	const author = getIssueAuthor(newsletter, issue);
	return [
		"<item>",
		issue.kind === "note" ? "" : `<title>${escapeXml(issue.subject)}</title>`,
		`<link>${escapeXml(url)}</link>`,
		`<guid isPermaLink="false">${escapeXml(getFeedGuid(issue))}</guid>`,
		date ? `<pubDate>${toRssDate(date)}</pubDate>` : "",
		`<dc:creator>${escapeXml(author.name)}</dc:creator>`,
		`<description>${escapeXml(getExcerpt(issue, bodyHtml) || (issue.kind === "note" ? getReaderText(newsletter)("Short post") : ""))}</description>`,
		`<content:encoded>${cdata(bodyHtml)}</content:encoded>`,
		issue.thumbnailUrl ? `<media:thumbnail url="${escapeXml(toAbsoluteUrl(issue.thumbnailUrl, appUrl))}"/>` : "",
		"</item>",
	]
		.filter(Boolean)
		.join("\n");
}

// RSS 2.0 for a newsletter's archive, with the full body in content:encoded. issues: newest first, as listFeedIssues
// returns them. filter: which of them the feed may show (isFreeIssue by default).
// recommendations: the newsletter's live ones, for issues with {{recommendations}} in them. An issue the gate hides from readers who
// haven't subscribed is only its beginning here too.
export function buildFeed({ newsletter, issues, urls = getArchiveUrls(newsletter), appUrl = getAppUrl(), filter = isFreeIssue, recommendations = [] }) {
	const visible = issues.filter(filter).slice(0, FEED_ISSUE_LIMIT);
	const popup = getPopupSettings(newsletter);
	const freeIds = popup.gate.enabled ? issues.slice(0, popup.gate.freeLatest).map(({ _id }) => _id) : [];
	const getPreview = (issue) => (isGatedIssue(popup, issue, freeIds) ? makeTeaser(issue, getGateTeaserOptions(popup)) : null);
	const latest = visible.map(getIssueDate).filter(Boolean).sort((a, b) => b - a)[0];
	const imageUrl = newsletter.imageUrl && toAbsoluteUrl(newsletter.imageUrl, appUrl);
	const xml = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/">',
		"<channel>",
		`<title>${escapeXml(newsletter.name)}</title>`,
		`<link>${escapeXml(urls.siteIndex)}</link>`,
		`<description>${escapeXml(newsletter.description || newsletter.name)}</description>`,
		"<language>en</language>",
		`<atom:link href="${escapeXml(urls.feed)}" rel="self" type="application/rss+xml"/>`,
		latest ? `<lastBuildDate>${toRssDate(latest)}</lastBuildDate>` : "",
		"<generator>FlockStack</generator>",
		imageUrl
			? `<image><url>${escapeXml(imageUrl)}</url><title>${escapeXml(newsletter.name)}</title><link>${escapeXml(urls.siteIndex)}</link></image>`
			: "",
		...visible.map((issue) => buildItem({ issue, newsletter, urls, appUrl, recommendations, preview: getPreview(issue) })),
		"</channel>",
		"</rss>",
	]
		.filter(Boolean)
		.join("\n");
	return { xml: `${xml}\n`, lastModified: latest ?? null };
}

export function getFeedEtag(xml) {
	return `"${crypto.createHash("sha256").update(xml).digest("base64url").slice(0, 27)}"`;
}
