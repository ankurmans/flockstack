import { isSignedWithAppKey, signWithAppKey } from "./app-keys.js";
import { isObjectIdString } from "./validation.js";

// A contacts export link: the account and its filters, signed, for an hour. base64url JSON + "." + HMAC.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,1200}\.[A-Za-z0-9_-]{43}$/;
export const EXPORT_LINK_MS = 60 * 60 * 1000;

const INFO = "flockstack-contacts-export-v1";

export function createExportToken({ accountId, newsletterId, status, query, tag }, now = Date.now()) {
	const data = { a: String(accountId), e: Math.floor((now + EXPORT_LINK_MS) / 1000) };
	if (newsletterId) data.n = String(newsletterId);
	if (status) data.s = status;
	if (query) data.q = query;
	if (tag) data.t = tag;
	const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
	return { token: `${payload}.${signWithAppKey(INFO, payload)}`, expiresAt: new Date(data.e * 1000) };
}

export function verifyExportToken(token, now = Date.now()) {
	if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return null;
	const [payload, signature] = token.split(".");
	if (!isSignedWithAppKey(INFO, payload, signature)) return null;
	try {
		const { a, e, n, s, q, t } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
		if (!isObjectIdString(a) || !Number.isInteger(e) || e * 1000 < now) return null;
		if (n !== undefined && !isObjectIdString(n)) return null;
		return { accountId: a, newsletterId: n ?? null, status: typeof s === "string" ? s : null, query: typeof q === "string" ? q : "", tag: typeof t === "string" ? t : null };
	} catch {
		return null;
	}
}
