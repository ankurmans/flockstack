import crypto from "node:crypto";
import { getAppSecret } from "./config.js";
import { isObjectIdString } from "./validation.js";

// The link to an account export's ZIP: the account, the export and when it stops working, signed. base64url JSON + "." +
// HMAC, with a key of its own so no other link can stand in for it.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,400}\.[A-Za-z0-9_-]{43}$/;

function sign(payload) {
	const key = Buffer.from(crypto.hkdfSync("sha256", getAppSecret(), "", "flockstack-account-export-v1", 32));
	return crypto.createHmac("sha256", key).update(payload).digest("base64url");
}

export function createAccountExportToken({ accountId, exportId, expiresAt }) {
	const payload = Buffer.from(JSON.stringify({ a: String(accountId), x: String(exportId), e: Math.floor(new Date(expiresAt).getTime() / 1000) })).toString("base64url");
	return `${payload}.${sign(payload)}`;
}

export function verifyAccountExportToken(token, now = Date.now()) {
	if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return null;
	const [payload, signature] = token.split(".");
	const expected = Buffer.from(sign(payload));
	const provided = Buffer.from(signature);
	if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) return null;
	try {
		const { a, x, e } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
		if (!isObjectIdString(a) || !isObjectIdString(x) || !Number.isInteger(e) || e * 1000 < now) return null;
		return { accountId: a, exportId: x };
	} catch {
		return null;
	}
}
