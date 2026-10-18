import crypto from "node:crypto";
import { getArchiveUrls, getLinkBaseUrl } from "./archive-hosts.js";
import { getAppSecret } from "./config.js";
import { createContactToken, verifyContactToken } from "./contact-token.js";
import { isObjectIdString } from "./validation.js";

// A subscriber's referral code is their contact ID and a signature, so nothing is stored for it and nobody can guess
// another's. The page that shows their count and rewards has a signed link of its own, which never expires: it's in emails.
const CODE_PATTERN = /^[A-Za-z0-9_-]{27}$/;
const PAGE_INFO = "flockstack-referral-page-v1";
const PAGE_MAX_AGE_MS = 10 * 365 * 24 * 60 * 60 * 1000;
const ID_BYTES = 12;
const SIGNATURE_BYTES = 8;

function sign(id) {
	const key = Buffer.from(crypto.hkdfSync("sha256", getAppSecret(), "", "flockstack-referral-code-v1", 32));
	return crypto.createHmac("sha256", key).update(id).digest().subarray(0, SIGNATURE_BYTES);
}

export function createReferralCode(contactId) {
	const id = String(contactId ?? "").toLowerCase();
	if (!isObjectIdString(id)) throw new Error("Invalid referral reference");
	const bytes = Buffer.from(id, "hex");
	return Buffer.concat([bytes, sign(bytes)]).toString("base64url");
}

// The contact ID a code names, or null for a code that someone made up or mistyped.
export function readReferralCode(code) {
	if (typeof code !== "string" || !CODE_PATTERN.test(code)) return null;
	const bytes = Buffer.from(code, "base64url");
	const id = bytes.subarray(0, ID_BYTES);
	const provided = bytes.subarray(ID_BYTES);
	const expected = sign(id);
	if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return null;
	return id.toString("hex");
}

// The newsletter's website with the code: the signup form there carries it through to the signup.
export function getReferralLink(newsletter, contactId) {
	const url = new URL(getArchiveUrls(newsletter).siteIndex);
	url.searchParams.set("ref", createReferralCode(contactId));
	return url.toString();
}

export function createReferralPageToken({ contactId, newsletterId }, now = Date.now()) {
	return createContactToken({ info: PAGE_INFO, contactId, newsletterId }, now);
}

export function verifyReferralPageToken(token, now = Date.now()) {
	return verifyContactToken(token, { info: PAGE_INFO, maxAgeMs: PAGE_MAX_AGE_MS, now });
}

// On the newsletter's own host, like its unsubscribe page.
export function getReferralPageUrl({ contactId, newsletterId }, newsletter) {
	return `${getLinkBaseUrl(newsletter)}/referral?token=${createReferralPageToken({ contactId, newsletterId })}`;
}

// A keyed hash of an address, so the database can say "the same network" without keeping where anyone signed up from.
export function hashIp(ip) {
	if (!ip || ip === "unknown") return null;
	const key = Buffer.from(crypto.hkdfSync("sha256", getAppSecret(), "", "flockstack-referral-ip-v1", 32));
	return crypto.createHmac("sha256", key).update(String(ip)).digest("base64url").slice(0, 22);
}
