import { getArchiveAuthor, getIssueAuthor } from "./archive-author.js";
import { getArchiveUrls } from "./archive-hosts.js";
import { getIssueDate, getIssueModified } from "./archive-issues.js";
import { getAppUrl } from "./config.js";
import { checkJsonLd } from "./seo-rules.js";
import { getSocialPlatform } from "./social.js";

export const SHARE_IMAGE_SIZE = { width: 1200, height: 630 };

function absoluteUrl(url, appUrl) {
	return url?.startsWith("/") ? `${appUrl}${url}` : url;
}

function getXHandle(socialLinks = []) {
	const link = socialLinks.find((url) => getSocialPlatform(url)?.id === "x");
	const handle = link && new URL(link).pathname.split("/").find(Boolean);
	return handle ? `@${handle}` : undefined;
}

export function getShareCardUrl(newsletter, issue, appUrl = getAppUrl()) {
	const query = issue ? `?p=${encodeURIComponent(issue.archiveSlug)}` : "";
	return `${appUrl}/archive/${newsletter.slug}/og${query}`;
}

// The issue's first picture, or a generated card when it has none.
export function getShareImage(newsletter, issue, appUrl = getAppUrl()) {
	const alt = issue?.seo?.title || issue?.subject || newsletter.name;
	if (issue?.seo?.imageUrl) return { url: absoluteUrl(issue.seo.imageUrl, appUrl), alt };
	if (issue?.thumbnailUrl) return { url: absoluteUrl(issue.thumbnailUrl, appUrl), alt };
	return { url: getShareCardUrl(newsletter, issue, appUrl), ...SHARE_IMAGE_SIZE, alt };
}

function baseMetadata(newsletter, canonical, appUrl) {
	return {
		metadataBase: new URL(appUrl),
		alternates: {
			canonical,
			// Feed readers and browsers find the RSS feed from any page of the archive.
			types: { "application/rss+xml": [{ url: getArchiveUrls(newsletter, { appUrl }).feed, title: newsletter.name }] },
		},
		icons: newsletter.imageUrl ? { icon: newsletter.imageUrl } : undefined,
		robots: { index: true, follow: true },
	};
}

function twitterMetadata(newsletter, { title, description, image, card = "summary_large_image" }) {
	const handle = getXHandle(newsletter.socialLinks);
	return { card, title, description, images: [image], site: handle, creator: handle };
}

// Search engines tie every issue to one person, whose page lists the profiles that are theirs.
function getPerson(newsletter, appUrl) {
	const author = getArchiveAuthor(newsletter);
	return {
		"@type": "Person",
		name: author.name,
		url: getArchiveUrls(newsletter, { appUrl }).absoluteAuthor(author.slug),
		...(author.imageUrl && { image: absoluteUrl(author.imageUrl, appUrl) }),
		...(author.bio && { description: author.bio }),
		sameAs: newsletter.socialLinks,
	};
}

// The shop's pages: the shop, a product, the paid subscription.
export function getShopMetadata(newsletter, { title, description, url }, appUrl = getAppUrl()) {
	return {
		...baseMetadata(newsletter, url, appUrl),
		title: { absolute: title },
		description,
		openGraph: { type: "website", siteName: newsletter.name, locale: "en_US", url, title, description },
	};
}

export function getIssueSeo(newsletter, issue, appUrl = getAppUrl()) {
	const urls = getArchiveUrls(newsletter, { appUrl });
	const url = urls.absolutePost(issue.archiveSlug);
	// The owner's search title and description over the subject and the preview text; the subject stays the headline.
	const title = issue.seo?.title || issue.subject;
	const description = issue.seo?.description || issue.previewText || newsletter.description;
	const image = getShareImage(newsletter, issue, appUrl);
	const guest = getIssueAuthor(newsletter, issue);
	const author = guest.slug ? getPerson(newsletter, appUrl) : { "@type": "Person", name: guest.name };
	// Sent issues don't change; updatedAt moves with stats and pins, not with the content.
	const publishedAt = getIssueDate(issue)?.toISOString();
	const modifiedAt = getIssueModified(issue)?.toISOString();

	return {
		metadata: {
			...baseMetadata(newsletter, url, appUrl),
			robots: { index: !issue.seo?.noindex, follow: true },
			title: { absolute: title },
			description,
			authors: [{ name: author.name, ...(author.url && { url: author.url }) }],
			openGraph: {
				type: "article",
				siteName: newsletter.name,
				locale: "en_US",
				url,
				title,
				description,
				publishedTime: publishedAt,
				...(author.url && { authors: [author.url] }),
				images: [image],
			},
			twitter: twitterMetadata(newsletter, { title, description, image }),
		},
		jsonLd: {
			"@context": "https://schema.org",
			"@type": "BlogPosting",
			headline: issue.subject,
			description,
			url,
			...(issue.audience === "paid" && { isAccessibleForFree: false }),
			mainEntityOfPage: { "@type": "WebPage", "@id": url },
			image: [image.url],
			datePublished: publishedAt,
			dateModified: modifiedAt,
			author,
			publisher: {
				"@type": "Organization",
				name: newsletter.name,
				...(newsletter.imageUrl && { logo: { "@type": "ImageObject", url: absoluteUrl(newsletter.imageUrl, appUrl) } }),
			},
			isPartOf: { "@type": "Blog", name: newsletter.name, url: urls.siteIndex },
		},
	};
}

// The newsletter's own structured data (lib/seo-rules.js), blocks ready to embed: the home page and the issues carry them.
export function getCustomJsonLd(newsletter) {
	return checkJsonLd(newsletter.jsonLd).blocks ?? [];
}

export function getHomeSeo(newsletter, appUrl = getAppUrl()) {
	const { siteIndex: url } = getArchiveUrls(newsletter, { appUrl });
	const title = newsletter.name;
	const description = newsletter.description;
	const image = getShareImage(newsletter, null, appUrl);

	return {
		metadata: {
			...baseMetadata(newsletter, url, appUrl),
			title: { absolute: title },
			description,
			openGraph: { type: "website", siteName: title, locale: "en_US", url, title, description, images: [image] },
			twitter: twitterMetadata(newsletter, { title, description, image }),
		},
		jsonLd: {
			"@context": "https://schema.org",
			"@type": "Blog",
			name: title,
			description,
			url,
			...(newsletter.imageUrl && { image: absoluteUrl(newsletter.imageUrl, appUrl) }),
			author: getPerson(newsletter, appUrl),
		},
	};
}

// The photo shares as a square card; without one, the archive's card stands in.
export function getAuthorSeo(newsletter, appUrl = getAppUrl()) {
	const person = getPerson(newsletter, appUrl);
	const description = person.description || newsletter.description;
	const image = person.image ? { url: person.image, alt: person.name } : getShareImage(newsletter, null, appUrl);

	return {
		metadata: {
			...baseMetadata(newsletter, person.url, appUrl),
			title: { absolute: person.name },
			description,
			openGraph: {
				type: "profile",
				siteName: newsletter.name,
				locale: "en_US",
				url: person.url,
				title: person.name,
				description,
				images: [image],
			},
			twitter: twitterMetadata(newsletter, {
				title: person.name,
				description,
				image,
				card: person.image ? "summary" : "summary_large_image",
			}),
		},
		jsonLd: { "@context": "https://schema.org", "@type": "ProfilePage", url: person.url, mainEntity: person },
	};
}
