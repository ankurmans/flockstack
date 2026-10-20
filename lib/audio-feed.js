import { getArchiveUrls } from "./archive-hosts.js";
import { escapeXml, getFeedEtag, toRssDate } from "./archive-feed.js";
import { getIssueDate } from "./archive-issues.js";
import { getArchiveAuthor } from "./archive-author.js";
import { getAudioUrl } from "./audio-config.js";
import { DEFAULT_PODCAST_CATEGORY, PODCAST_CATEGORIES } from "./podcast-categories.js";
import { getAppUrl } from "./config.js";

// A newsletter's podcast: RSS 2.0 with the iTunes tags Apple Podcasts and Spotify read and the enclosure each episode needs
// (url, length in bytes, type). One episode for each issue that has audio and is for everyone; an issue for paid subscribers
// only, and any audio made for paid readers, never appears (listPodcastEpisodes, and the filter below as a second check).
export const PODCAST_EPISODE_LIMIT = 100;
const DESCRIPTION_LIMIT = 4000;

function toAbsoluteUrl(url, appUrl) {
	return url?.startsWith("/") ? `${appUrl}${url}` : url;
}

// HH:MM:SS, which every podcast app reads.
export function formatDuration(seconds) {
	const total = Math.max(0, Math.round(seconds));
	const pad = (value) => String(value).padStart(2, "0");
	return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

export function getEpisodeGuid(episode) {
	return `flockstack-audio:${String(episode.issue._id)}`;
}

// An episode is public when its issue and its audio are: nothing else is ever listed.
export function isPublicEpisode({ issue, audio }) {
	return audio?.file?.scope === "public" && issue.audience !== "paid" && (!issue.access || issue.access === "free") && Boolean(audio.file.key && issue.archiveSlug);
}

function buildItem({ issue, audio }, { urls, appUrl, explicit }) {
	const url = urls.absolutePost(issue.archiveSlug);
	const date = getIssueDate(issue);
	const image = issue.thumbnailUrl && toAbsoluteUrl(issue.thumbnailUrl, appUrl);
	const description = (issue.previewText?.trim() || issue.subject || "").slice(0, DESCRIPTION_LIMIT);
	return [
		"<item>",
		`<title>${escapeXml(issue.subject)}</title>`,
		`<link>${escapeXml(url)}</link>`,
		`<guid isPermaLink="false">${escapeXml(getEpisodeGuid({ issue }))}</guid>`,
		date ? `<pubDate>${toRssDate(date)}</pubDate>` : "",
		`<description>${escapeXml(description)}</description>`,
		`<enclosure url="${escapeXml(getAudioUrl(urls, issue.archiveSlug, audio.file, { versioned: false }))}" length="${Math.max(0, Math.round(audio.file.bytes ?? 0))}" type="audio/mpeg"/>`,
		`<itunes:duration>${formatDuration(audio.file.seconds ?? 0)}</itunes:duration>`,
		`<itunes:explicit>${explicit ? "true" : "false"}</itunes:explicit>`,
		"<itunes:episodeType>full</itunes:episodeType>",
		image ? `<itunes:image href="${escapeXml(image)}"/>` : "",
		"</item>",
	]
		.filter(Boolean)
		.join("\n");
}

// episodes: [{ issue, audio }], newest first.
export function buildPodcastFeed({ newsletter, episodes, urls = getArchiveUrls(newsletter), appUrl = getAppUrl() }) {
	const visible = episodes.filter(isPublicEpisode).slice(0, PODCAST_EPISODE_LIMIT);
	const settings = newsletter.audio?.podcast ?? {};
	const author = getArchiveAuthor(newsletter);
	const explicit = Boolean(settings.explicit);
	const category = PODCAST_CATEGORIES.includes(settings.category) ? settings.category : DEFAULT_PODCAST_CATEGORY;
	const description = (newsletter.description || newsletter.name).slice(0, DESCRIPTION_LIMIT);
	const imageUrl = newsletter.imageUrl && toAbsoluteUrl(newsletter.imageUrl, appUrl);
	const dates = visible.map(({ issue }) => getIssueDate(issue)).filter(Boolean).sort((a, b) => b - a);
	const latest = dates[0] ?? null;
	const xml = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">',
		"<channel>",
		`<title>${escapeXml(newsletter.name)}</title>`,
		`<link>${escapeXml(urls.siteIndex)}</link>`,
		`<description>${escapeXml(description)}</description>`,
		"<language>en</language>",
		`<atom:link href="${escapeXml(urls.podcast)}" rel="self" type="application/rss+xml"/>`,
		latest ? `<lastBuildDate>${toRssDate(latest)}</lastBuildDate>` : "",
		"<generator>FlockStack</generator>",
		imageUrl ? `<image><url>${escapeXml(imageUrl)}</url><title>${escapeXml(newsletter.name)}</title><link>${escapeXml(urls.siteIndex)}</link></image>` : "",
		`<itunes:author>${escapeXml(author.name)}</itunes:author>`,
		`<itunes:summary>${escapeXml(description)}</itunes:summary>`,
		"<itunes:type>episodic</itunes:type>",
		`<itunes:explicit>${explicit ? "true" : "false"}</itunes:explicit>`,
		imageUrl ? `<itunes:image href="${escapeXml(imageUrl)}"/>` : "",
		`<itunes:category text="${escapeXml(category)}"/>`,
		settings.ownerEmail
			? `<itunes:owner><itunes:name>${escapeXml(author.name)}</itunes:name><itunes:email>${escapeXml(settings.ownerEmail)}</itunes:email></itunes:owner>`
			: "",
		...visible.map((episode) => buildItem(episode, { urls, appUrl, explicit })),
		"</channel>",
		"</rss>",
	]
		.filter(Boolean)
		.join("\n");
	return { xml: `${xml}\n`, lastModified: latest, etag: getFeedEtag(xml) };
}
