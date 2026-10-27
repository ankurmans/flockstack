import { isSignedWithAppKey, signWithAppKey } from "./app-keys.js";
import { SENT_WITH_URL } from "./site.js";

// Opens: a 1×1 image. Clicks: links through FlockStack that redirect to the original URL. Both carry
// the message ID and an HMAC, so they can't be forged or used to redirect anywhere else. A click link also carries
// the link's place among the email's tracked links, which counts clicks per link (lib/link-clicks.js); links in
// emails sent before it have none and still work.
const SIGNATURE_LENGTH = 22;
const OPEN_TOKEN_PATTERN = /^([a-f0-9]{24})\.([A-Za-z0-9_-]{22})$/;
const CLICK_TOKEN_PATTERN = /^([a-f0-9]{24})\.([A-Za-z0-9_-]{22})\.(?:(\d{1,3})\.)?([A-Za-z0-9_-]{4,4000})$/;
const CLICK_PATH_PATTERN = /\/c\/([^/?#"'\s]+)$/;
// Past this many, links are tracked without their place: a campaign's report lists this many at most.
export const MAX_TRACKED_LINKS = 100;
const LINK_PATTERN = /(<a\b[^>]*?\shref\s*=\s*)(["'])(https?:\/\/[^"'\s]+)\2/gi;
const PIXEL_STYLE = "display:block;width:1px;height:1px;border:0;";
// Security gateways (Microsoft, Proofpoint, Mimecast…) open every link as the email arrives.
const SCANNER_PATTERN =
	/bot|crawl|spider|preview|scan|proofpoint|mimecast|barracuda|safelinks|python|curl|wget|java\/|okhttp|go-http|headless/i;
const SCANNER_WINDOW_MS = 30_000;

// Rotating the secret breaks the signatures of links in already-sent emails unless the old one stays in
// BETTER_AUTH_SECRET_PREVIOUS (see readClickToken).
const INFO = "flockstack-tracking-v1";

function sign(value) {
	return signWithAppKey(INFO, value, SIGNATURE_LENGTH);
}

function isSigned(value, signature) {
	return isSignedWithAppKey(INFO, value, signature, SIGNATURE_LENGTH);
}

function isHttpUrl(value) {
	try {
		return ["http:", "https:"].includes(new URL(value).protocol);
	} catch {
		return false;
	}
}

function isUnsubscribeUrl(value) {
	try {
		return /^\/(api\/)?unsubscribe\/?$/.test(new URL(value).pathname);
	} catch {
		return false;
	}
}

export function getOpenUrl(baseUrl, messageId) {
	const id = String(messageId).toLowerCase();
	return `${baseUrl}/o/${id}.${sign(`open:${id}`)}`;
}

// link: the link's place in the email, from 0. Without one, the token is the older kind.
export function getClickUrl(baseUrl, messageId, url, link) {
	const id = String(messageId).toLowerCase();
	const encoded = Buffer.from(url).toString("base64url");
	if (!Number.isInteger(link)) return `${baseUrl}/c/${id}.${sign(`click:${id}:${url}`)}.${encoded}`;
	return `${baseUrl}/c/${id}.${sign(`click:${id}:${link}:${url}`)}.${link}.${encoded}`;
}

export function readOpenToken(token) {
	const match = OPEN_TOKEN_PATTERN.exec(String(token ?? ""));
	return match && isSigned(`open:${match[1]}`, match[2]) ? match[1] : null;
}

// A link whose signature doesn't match still decodes, so its page can be offered with a plain link.
export function readClickToken(token) {
	const match = CLICK_TOKEN_PATTERN.exec(String(token ?? ""));
	if (!match) return null;
	const url = Buffer.from(match[4], "base64url").toString("utf8");
	if (!isHttpUrl(url)) return null;
	if (match[3] === undefined) return { messageId: match[1], url, isSigned: isSigned(`click:${match[1]}:${url}`, match[2]) };
	const link = Number(match[3]);
	return { messageId: match[1], url, link, isSigned: isSigned(`click:${match[1]}:${link}:${url}`, match[2]) };
}

// Unsubscribe links stay direct, as inbox providers expect. The pixel goes first so it still loads
// when Gmail clips a long email.
export function addTracking(html, { baseUrl, messageId, sponsorshipIndexes = null }) {
	let count = 0;
	const withLinks = html.replace(LINK_PATTERN, (link, start, quote, href) => {
		const url = href.replace(/&amp;|&#0*38;|&#x0*26;/gi, "&");
		if (isUnsubscribeUrl(url) || url === SENT_WITH_URL) return link;
		const bookingId = /\sdata-sponsor-booking="([a-f0-9]{24})"/i.exec(start)?.[1];
		const reserved = bookingId && sponsorshipIndexes?.get(bookingId);
		const index = Number.isInteger(reserved) && reserved >= 100 && reserved < 110 ? reserved : count++;
		return `${start}${quote}${getClickUrl(baseUrl, messageId, url, index < MAX_TRACKED_LINKS || index === reserved ? index : undefined)}${quote}`;
	});
	const pixel = `<img src="${getOpenUrl(baseUrl, messageId)}" width="1" height="1" alt="" style="${PIXEL_STYLE}">`;
	return /<body\b[^>]*>/i.test(withLinks)
		? withLinks.replace(/<body\b[^>]*>/i, (tag) => `${tag}${pixel}`)
		: `${pixel}${withLinks}`;
}

// Each tracked link of an email addTracking made, in order: replace({ link, url, start, quote }) gives what stands in
// for its opening tag up to the end of its href. Links without a place are left as they are.
export function replaceTrackedLinks(html, replace) {
	return html.replace(LINK_PATTERN, (match, start, quote, href) => {
		const token = CLICK_PATH_PATTERN.exec(href)?.[1];
		const tracked = token ? readClickToken(token) : null;
		if (!tracked?.isSigned || tracked.link === undefined) return match;
		return replace({ link: tracked.link, url: tracked.url, start, quote });
	});
}

// The links of a tracked email by their place: what a campaign's report lists.
export function readTrackedLinks(html) {
	const links = [];
	replaceTrackedLinks(html, ({ link, url, start, quote }) => {
		links.push({ index: link, url });
		return `${start}${quote}${url}${quote}`;
	});
	return links;
}

// Scanners still get redirected; their visits just don't count as clicks.
export function isLikelyScanner({ userAgent, sentAt, now = Date.now() }) {
	if (!userAgent || SCANNER_PATTERN.test(userAgent)) return true;
	return Boolean(sentAt) && now - new Date(sentAt).getTime() < SCANNER_WINDOW_MS;
}
