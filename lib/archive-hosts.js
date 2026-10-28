import { getAppUrl, getSharedDomain } from "./config.js";
import { toHostPath } from "./mount-rules.js";

const LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function toHostname(host) {
	return String(host ?? "")
		.toLowerCase()
		.split(":")[0];
}

// A newsletter's archive and the links in its emails (tracking, unsubscribe, confirmation) live on the
// account's verified archive subdomain, else on <slug>.<shared domain>. Without SHARED_DOMAIN (local
// development) they stay on APP_URL. A verified mount (lib/mount-rules.js) moves the archive's pages, never the links in emails:
// an email already sent keeps working if the owner's proxy breaks or the mount is removed.
export function getNewsletterHost(newsletter, sharedDomain = getSharedDomain()) {
	if (newsletter?.archiveHost) return newsletter.archiveHost;
	return sharedDomain && newsletter?.slug ? `${newsletter.slug}.${sharedDomain}` : null;
}

// The mount's address once check_newsletter_mount saw the owner's proxy forward with its token, else null.
export function getMountUrl(newsletter) {
	const mount = newsletter?.mount;
	return mount?.url && mount.verifiedAt ? mount.url : null;
}

// Where the owner's proxy forwards a mount: the newsletter's shared host, else its archive under APP_URL.
export function getMountUpstream(newsletter, { sharedDomain = getSharedDomain(), appUrl = getAppUrl() } = {}) {
	return sharedDomain && newsletter?.slug ? `https://${newsletter.slug}.${sharedDomain}` : `${appUrl}/archive/${newsletter.slug}`;
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

// Where an app-domain /archive path lives on the newsletter's shared subdomain, or null without SHARED_DOMAIN.
export function getArchiveHostUrl(pathname, search = "", sharedDomain = getSharedDomain()) {
	const match = ARCHIVE_PATH_PATTERN.exec(pathname);
	const host = match && getNewsletterHost({ slug: match[1] }, sharedDomain);
	if (!host) return null;
	return `https://${host}${toHostPath(match[2])}${search}`;
}

// Archive pages are cached once for every host, so their links can't depend on the request. Without a
// host, the archive lives at APP_URL/archive/<slug>. A verified mount is the base of every page: its paths are read as on the
// newsletter's host whatever the upstream (proxy.js), so they take the host's shape.
export function getArchiveUrls(newsletter, { sharedDomain = getSharedDomain(), appUrl = getAppUrl() } = {}) {
	const host = getNewsletterHost(newsletter, sharedDomain);
	const mount = getMountUrl(newsletter);
	const isHostStyle = Boolean(host || mount);
	const base = mount ?? (host ? `https://${host}` : `/archive/${newsletter.slug}`);
	const absoluteBase = isHostStyle ? base : `${appUrl}${base}`;
	// A host's home is its root, https://host/. A mount's is its path without a slash: the owner's site redirects the slash away,
	// so a canonical, sitemap entry or feed link ending in one would name a redirect.
	const home = mount ? base : isHostStyle ? `${base}/` : base;
	return {
		host,
		mount,
		index: home,
		post: (postSlug) => `${base}/p/${postSlug}`,
		author: (authorSlug) => `${base}/authors/${authorSlug}`,
		siteIndex: isHostStyle ? home : absoluteBase,
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
		absoluteMarkdown: (postSlug) => isHostStyle ? `${absoluteBase}/p/${postSlug}.md` : `${absoluteBase}/markdown/${postSlug}`,
		absoluteAuthor: (authorSlug) => `${absoluteBase}/authors/${authorSlug}`,
		// The RSS feed: /feed.xml on the newsletter's own host, under /archive without one.
		feed: isHostStyle ? `${base}/feed.xml` : `${absoluteBase}/feed`,
		// The podcast feed of the issues that have audio, and an issue's audio file (lib/audio-feed.js, lib/audio-serve.js):
		// /podcast.xml and /audio/<slug>.mp3 on the newsletter's own host, under /archive without one.
		podcast: isHostStyle ? `${base}/podcast.xml` : `${absoluteBase}/podcast`,
		audio: (postSlug) => (isHostStyle ? `${base}/audio/${postSlug}.mp3` : `${base}/audio/${postSlug}`),
		absoluteAudio: (postSlug) => (isHostStyle ? `${base}/audio/${postSlug}.mp3` : `${absoluteBase}/audio/${postSlug}`),
		// The sitemap, robots.txt and llms.txt: at the root of the newsletter's own host, under /archive without one.
		sitemap: isHostStyle ? `${base}/sitemap.xml` : `${absoluteBase}/sitemap`,
		robots: isHostStyle ? `${base}/robots.txt` : `${absoluteBase}/robots`,
		llms: isHostStyle ? `${base}/llms.txt` : `${absoluteBase}/llms`,
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
