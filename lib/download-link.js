import { getAppSecret } from "./config.js";

// A buyer's download link: base64url JSON { o: order, v: the order's link version, e: expiry in ms } + "." + HMAC-SHA256.
// It expires (7 days), dies with a refund or a chargeback (the route checks the order), and a newer link replaces it (the
// version). Signed with a key of its own derived from the app secret, so no other link can stand in for it. WebCrypto only.
export const DOWNLOAD_LINK_DAYS = 7;
export const MAX_DOWNLOADS_PER_ORDER = 20;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,300}\.[A-Za-z0-9_-]{43}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64Url(bytes) {
	return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value) {
	const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
	return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function hmac(keyBytes, message) {
	const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

async function sign(payload) {
	const keyBytes = await hmac(encoder.encode(getAppSecret()), "flockstack-download-link-v1");
	return toBase64Url(await hmac(keyBytes, payload));
}

function isEqual(left, right) {
	if (left.length !== right.length) return false;
	let difference = 0;
	for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
	return difference === 0;
}

export async function createDownloadToken({ orderId, version = 1, now = Date.now(), days = DOWNLOAD_LINK_DAYS }) {
	const payload = toBase64Url(encoder.encode(JSON.stringify({ o: String(orderId), v: version, e: now + days * 86_400_000 })));
	return `${payload}.${await sign(payload)}`;
}

// { orderId, version }, or null for a link that is malformed, forged or expired.
export async function verifyDownloadToken(token, { now = Date.now() } = {}) {
	if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return null;
	const [payload, signature] = token.split(".");
	if (!isEqual(signature, await sign(payload))) return null;
	try {
		const { o, v, e } = JSON.parse(decoder.decode(fromBase64Url(payload)));
		if (typeof o !== "string" || !Number.isInteger(v) || !Number.isInteger(e) || e < now) return null;
		return { orderId: o, version: v };
	} catch {
		return null;
	}
}
