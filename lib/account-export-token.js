import { isSignedWithAppKey, signWithAppKey } from "./app-keys.js";
import { isObjectIdString } from "./validation.js";

// The link to an account export's ZIP: the account, the export and when it stops working, signed. base64url JSON + "." +
// HMAC, with a key of its own so no other link can stand in for it.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,400}\.[A-Za-z0-9_-]{43}$/;

const INFO = "flockstack-account-export-v1";

export function createAccountExportToken({ accountId, exportId, expiresAt }) {
	const payload = Buffer.from(JSON.stringify({ a: String(accountId), x: String(exportId), e: Math.floor(new Date(expiresAt).getTime() / 1000) })).toString("base64url");
	return `${payload}.${signWithAppKey(INFO, payload)}`;
}

export function verifyAccountExportToken(token, now = Date.now()) {
	if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return null;
	const [payload, signature] = token.split(".");
	if (!isSignedWithAppKey(INFO, payload, signature)) return null;
	try {
		const { a, x, e } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
		if (!isObjectIdString(a) || !isObjectIdString(x) || !Number.isInteger(e) || e * 1000 < now) return null;
		return { accountId: a, exportId: x };
	} catch {
		return null;
	}
}
