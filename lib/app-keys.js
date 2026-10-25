import crypto from "node:crypto";
import { getAppSecret, getAppSecrets } from "./config.js";

// The keys that sign the links of emails and the other tokens, derived from BETTER_AUTH_SECRET: one per kind of link (info), so
// one can never stand in for another. Signing always uses the current secret; checking tries the previous ones too
// (BETTER_AUTH_SECRET_PREVIOUS), so a rotation leaves every link already sent working (docs/AUTH-ROTATION.md).
function derive(secret, info) {
	return Buffer.from(crypto.hkdfSync("sha256", secret, "", info, 32));
}

export function deriveAppKey(info) {
	return derive(getAppSecret(), info);
}

// The current key, then one for each previous secret.
export function deriveAppKeys(info) {
	return getAppSecrets().map((secret) => derive(secret, info));
}

function hmac(key, value, length) {
	return crypto.createHmac("sha256", key).update(value).digest("base64url").slice(0, length);
}

// base64url HMAC-SHA256 with the current secret's key, cut to length (43 is all of it).
export function signWithAppKey(info, value, length = 43) {
	return hmac(deriveAppKey(info), value, length);
}

// Whether the signature is what the current secret, or a previous one, makes of the value. Its length has to be exactly length.
export function isSignedWithAppKey(info, value, signature, length = 43) {
	if (typeof signature !== "string" || signature.length !== length) return false;
	const provided = Buffer.from(signature);
	return deriveAppKeys(info).some((key) => crypto.timingSafeEqual(Buffer.from(hmac(key, value, length)), provided));
}
