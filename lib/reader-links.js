import { getLinkBaseUrl } from "./archive-hosts.js";
import { createContactToken, verifyContactToken } from "./contact-token.js";
import { ARCHIVE_SLUG_PATTERN } from "./slug.js";

// A subscriber proves who they are with a signed link, not a password: each kind of link signs with a key of its own
// (contact-token.js), so a link from a newsletter email can't stand in for a sign-in link or a session.
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const KINDS = {
	// In the newsletter's emails, so it lives long enough to be found in an inbox.
	email: { info: "flockstack-comment-link-v1", maxAgeMs: 45 * DAY_MS },
	// Asked for on a page: short, and good for one use (the contact remembers the last one used).
	signin: { info: "flockstack-comment-signin-v1", maxAgeMs: 30 * MINUTE_MS },
	// What the browser keeps after either of them.
	session: { info: "flockstack-comment-session-v1", maxAgeMs: 30 * DAY_MS },
	// The link in a reply email that turns those emails off.
	replies: { info: "flockstack-comment-replies-v1", maxAgeMs: 10 * 365 * DAY_MS },
};

export const SESSION_MAX_AGE_SECONDS = KINDS.session.maxAgeMs / 1000;
export const SIGNIN_MINUTES = KINDS.signin.maxAgeMs / MINUTE_MS;

export function createReaderToken(kind, { contactId, newsletterId }, now = Date.now()) {
	return createContactToken({ info: KINDS[kind].info, contactId, newsletterId }, now);
}

// { contactId, newsletterId } or null for a token that is forged, for another kind of link, or past its time.
export function verifyReaderToken(kind, token, now = Date.now()) {
	return verifyContactToken(token, { info: KINDS[kind].info, maxAgeMs: KINDS[kind].maxAgeMs, now });
}

// The moment a token was made, in seconds, for the one-time check. Only called on a token that verified.
export function readTokenTime(token) {
	return JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8")).t;
}

export function readerCookieName(slug) {
	return `fs_reader_${slug}`;
}

// The page can read this one: it says a session exists, so a visitor without one costs no request.
export function readerMarkerName(slug) {
	return `fs_reader_${slug}_on`;
}

function withIssue(url, issueSlug, commentId) {
	if (ARCHIVE_SLUG_PATTERN.test(issueSlug ?? "")) url.searchParams.set("p", issueSlug);
	if (/^[a-f0-9]{24}$/i.test(commentId ?? "")) url.searchParams.set("c", commentId);
	return url.toString();
}

// Links live on the newsletter's own host, like the unsubscribe link, so the cookie they set belongs to its archive.
function readerUrl(path, kind, reference, newsletter, { issueSlug, commentId } = {}) {
	const url = new URL(`${getLinkBaseUrl(newsletter)}${path}`);
	url.searchParams.set("token", createReaderToken(kind, reference));
	return withIssue(url, issueSlug, commentId);
}

// From the issue's email: signs the reader in and lands on the issue's comments.
export function getEmailCommentUrl(reference, newsletter, options) {
	return readerUrl("/reader/in", "email", reference, newsletter, options);
}

// From the sign-in email: a page with a button, so a mail scanner opening the link doesn't use it up.
export function getSignInUrl(reference, newsletter, options) {
	return readerUrl("/reader/signin", "signin", reference, newsletter, options);
}

export function getRepliesOffUrl(reference, newsletter) {
	return readerUrl("/reader/replies", "replies", reference, newsletter);
}
