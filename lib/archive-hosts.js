import { getAppUrl, getSharedDomain } from "./config.js";

const LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function toHostname(host) {
	return String(host ?? "")
		.toLowerCase()
		.split(":")[0];
}

// A newsletter's archive and the links in its emails (tracking, unsubscribe, confirmation) live on the
// account's verified archive subdomain, else on <slug>.<shared domain>. Without SHARED_DOMAIN (local
// development) they stay on APP_URL.
export function getNewsletterHost(newsletter, sharedDomain = getSharedDomain()) {
	if (newsletter?.archiveHost) return newsletter.archiveHost;
	return sharedDomain && newsletter?.slug ? `${newsletter.slug}.${sharedDomain}` : null;
}

export function getLinkBaseUrl(newsletter, { sharedDomain = getSharedDomain(), appUrl = getAppUrl() } = {}) {
	const host = getNewsletterHost(newsletter, sharedDomain);
	return host ? `https://${host}` : appUrl;
}

// weekly.flockstack.io -> weekly. Only one label deep: a.b.flockstack.io is nobody's.
export function getSlugForSharedHost(host, sharedDomain = getSharedDomain()) {
	const hostname = toHostname(host);
	if (!sharedDomain || !hostname.endsWith(`.${sharedDomain}`)) return null;
	const label = hostname.slice(0, -sharedDomain.length - 1);
	return LABEL_PATTERN.test(label) ? label : null;
}

const ARCHIVE_PATH_PATTERN = /^\/archive\/([^/]+)(\/.*)?$/;
const HOST_PATHS = { "/sitemap": "/sitemap.xml", "/robots": "/robots.txt", "/feed": "/feed.xml", "/llms": "/llms.txt", "/podcast": "/podcast.xml" };
const AUDIO_PATH_PATTERN = /^\/audio\/([a-z0-9-]+)$/;

// Where an app-domain /archive path lives on the newsletter's shared subdomain, or null without SHARED_DOMAIN.
export function getArchiveHostUrl(pathname, search = "", sharedDomain = getSharedDomain()) {
	const match = ARCHIVE_PATH_PATTERN.exec(pathname);
	const host = match && getNewsletterHost({ slug: match[1] }, sharedDomain);
	if (!host) return null;
	const path = match[2] ?? "/";
	const markdown = /^\/markdown\/([a-z0-9-]+)$/.exec(path)?.[1];
	if (markdown) return `https://${host}/p/${markdown}.md${search}`;
	const audio = AUDIO_PATH_PATTERN.exec(path)?.[1];
	return `https://${host}${audio ? `/audio/${audio}.mp3` : (HOST_PATHS[path] ?? path)}${search}`;
}

// Archive pages are cached once for every host, so their links can't depend on the request. Without a
// host, the archive lives at APP_URL/archive/<slug>.
export function getArchiveUrls(newsletter, { sharedDomain = getSharedDomain(), appUrl = getAppUrl() } = {}) {
	const host = getNewsletterHost(newsletter, sharedDomain);
	const base = host ? `https://${host}` : `/archive/${newsletter.slug}`;
	const absoluteBase = host ? base : `${appUrl}${base}`;
	return {
		host,
		index: host ? `${base}/` : base,
		post: (postSlug) => `${base}/p/${postSlug}`,
		author: (authorSlug) => `${base}/authors/${authorSlug}`,
		siteIndex: host ? `${base}/` : absoluteBase,
		// The paged list of issues, a tag's page, and the reader's sign-in and Subscriber Center.
		issues: `${base}/issues`,
		tag: (tagSlug) => `${base}/tags/${tagSlug}`,
		signin: `${base}/signin`,
		account: `${base}/account`,
		perks: `${base}/perks`,
		absolutePerks: `${absoluteBase}/perks`,
		absoluteIssues: `${absoluteBase}/issues`,
		absoluteTag: (tagSlug) => `${absoluteBase}/tags/${tagSlug}`,
		absoluteSignin: `${absoluteBase}/signin`,
		absoluteAccount: `${absoluteBase}/account`,
		absolutePost: (postSlug) => `${absoluteBase}/p/${postSlug}`,
		absoluteMarkdown: (postSlug) => host ? `${absoluteBase}/p/${postSlug}.md` : `${absoluteBase}/markdown/${postSlug}`,
		absoluteAuthor: (authorSlug) => `${absoluteBase}/authors/${authorSlug}`,
		// The RSS feed: /feed.xml on the newsletter's own host, under /archive without one.
		feed: host ? `${base}/feed.xml` : `${absoluteBase}/feed`,
		// The podcast feed of the issues that have audio, and an issue's audio file (lib/audio-feed.js, lib/audio-serve.js):
		// /podcast.xml and /audio/<slug>.mp3 on the newsletter's own host, under /archive without one.
		podcast: host ? `${base}/podcast.xml` : `${absoluteBase}/podcast`,
		audio: (postSlug) => (host ? `${base}/audio/${postSlug}.mp3` : `${base}/audio/${postSlug}`),
		absoluteAudio: (postSlug) => (host ? `${base}/audio/${postSlug}.mp3` : `${absoluteBase}/audio/${postSlug}`),
		// The sitemap, robots.txt and llms.txt: at the root of the newsletter's own host, under /archive without one.
		sitemap: host ? `${base}/sitemap.xml` : `${absoluteBase}/sitemap`,
		robots: host ? `${base}/robots.txt` : `${absoluteBase}/robots`,
		llms: host ? `${base}/llms.txt` : `${absoluteBase}/llms`,
		// The shop's pages: its products, and the paid subscription.
		shop: `${base}/shop`,
		product: (productSlug) => `${base}/shop/${productSlug}`,
		subscribe: `${base}/subscribe`,
		sponsor: `${base}/sponsor`,
		absoluteSponsor: `${absoluteBase}/sponsor`,
		// The link-in-bio page (lib/link-page.js).
		links: `${base}/links`,
		absoluteLinks: `${absoluteBase}/links`,
		absoluteShop: `${absoluteBase}/shop`,
		absoluteProduct: (productSlug) => `${absoluteBase}/shop/${productSlug}`,
		absoluteSubscribe: `${absoluteBase}/subscribe`,
		// An offer's page (the subscribe form with its discount applied), and the page where a gift is bought.
		offer: (code) => `${base}/offer/${code}`,
		absoluteOffer: (code) => `${absoluteBase}/offer/${code}`,
		give: `${base}/give`,
		absoluteGive: `${absoluteBase}/give`,
	};
}
