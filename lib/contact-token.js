import { isSignedWithAppKey, signWithAppKey } from "./app-keys.js";
import { isObjectIdString } from "./validation.js";

// Links that act for one contact and expire: base64url JSON payload + "." + HMAC-SHA256 (43 characters).
// Each kind of link signs with its own key (info), so one can never stand in for another.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,200}\.[A-Za-z0-9_-]{43}$/;

function sign(info, payload) {
	return signWithAppKey(info, payload);
}

export function createContactToken({ info, contactId, newsletterId }, now = Date.now()) {
	const reference = {
		c: String(contactId ?? "").toLowerCase(),
		n: String(newsletterId ?? "").toLowerCase(),
		t: Math.floor(now / 1000),
	};
	if (!isObjectIdString(reference.c) || !isObjectIdString(reference.n)) throw new Error("Invalid link reference");
	const payload = Buffer.from(JSON.stringify(reference)).toString("base64url");
	return `${payload}.${sign(info, payload)}`;
}

export function verifyContactToken(token, { info, maxAgeMs, now = Date.now() }) {
	if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return null;

	const [payload, signature] = token.split(".");
	if (!isSignedWithAppKey(info, payload, signature)) return null;

	try {
		const { c, n, t } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
		if (!isObjectIdString(c) || !isObjectIdString(n) || !Number.isInteger(t)) return null;
		if (now - t * 1000 > maxAgeMs) return null;
		return { contactId: c, newsletterId: n };
	} catch {
		return null;
	}
}
