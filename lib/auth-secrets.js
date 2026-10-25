import crypto from "node:crypto";
import { getAppSecrets } from "./config.js";

// What Better Auth needs to keep working across a rotation of BETTER_AUTH_SECRET (docs/AUTH-ROTATION.md). Its `secrets` option takes
// versioned secrets: the first signs and encrypts, and what was encrypted with any listed version stays readable. A version is
// derived from the secret itself, so nobody keeps a counter in step with the environment, and a value gets the same number on
// every Worker and in every rotation.
export function getSecretVersion(secret) {
	return crypto.createHash("sha256").update(`flockstack-secret-version:${secret}`).digest().readUInt32BE(0);
}

// The current secret first, then each previous one.
export function getVersionedSecrets(secrets = getAppSecrets()) {
	const seen = new Set();
	const versioned = [];
	for (const value of secrets) {
		const version = getSecretVersion(value);
		if (seen.has(version)) continue;
		seen.add(version);
		versioned.push({ version, value });
	}
	return versioned;
}

// Better Auth signs the cookies it sets (the session, the state of a sign-in with Google) with the current secret only. After a
// rotation a browser still holds cookies signed with a previous one: this signs them again with the current secret, in the
// request's own copy of the header, so the session carries on. Better Auth sets the cookie anew within a day of use (session.updateAge),
// signed with the current secret, which is why previous secrets only have to stay as long as a session lives.
const SIGNED_COOKIE = /^(.*)\.([A-Za-z0-9+/]{43}=)$/s;

function sign(value, secret) {
	return crypto.createHmac("sha256", secret).update(value).digest("base64");
}

function isSame(left, right) {
	return left.length === right.length && crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

export function resignCookieHeader(cookieHeader, { prefix, secrets = getAppSecrets() }) {
	const [current, ...previous] = secrets;
	if (!cookieHeader || previous.length === 0) return cookieHeader;
	const own = new RegExp(`^(?:__Secure-)?${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.`);
	let changed = false;
	const parts = cookieHeader.split(";").map((part) => {
		const separator = part.indexOf("=");
		if (separator === -1) return part;
		const name = part.slice(0, separator).trim();
		if (!own.test(name)) return part;
		let decoded;
		try {
			decoded = decodeURIComponent(part.slice(separator + 1).trim());
		} catch {
			return part;
		}
		const match = SIGNED_COOKIE.exec(decoded);
		if (!match) return part;
		const [, value, signature] = match;
		if (isSame(signature, sign(value, current))) return part;
		if (!previous.some((secret) => isSame(signature, sign(value, secret)))) return part;
		changed = true;
		return `${part.slice(0, separator + 1)}${encodeURIComponent(`${value}.${sign(value, current)}`)}`;
	});
	return changed ? parts.join(";") : cookieHeader;
}
