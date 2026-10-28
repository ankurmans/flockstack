import crypto from "node:crypto";

// A mount's token is shown once and kept only as its SHA-256, like an API key. A new one leaves the previous one working for a
// day, so the owner can change their proxy's secret without the website going down in between.
export const MOUNT_TOKEN_OVERLAP_MS = 24 * 60 * 60 * 1000;
const TOKEN_PATTERN = /^fsm_[A-Za-z0-9_-]{43}$/;

export function createMountToken() {
	return `fsm_${crypto.randomBytes(32).toString("base64url")}`;
}

export function hashMountToken(token) {
	return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function isSameHash(hash, expected) {
	if (typeof expected !== "string" || expected.length !== hash.length) return false;
	return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(expected));
}

// "current", "previous" (within its day) or null.
export function matchMountToken(mount, token, now = Date.now()) {
	if (!mount?.tokenHash || !TOKEN_PATTERN.test(String(token ?? "").trim())) return null;
	const hash = hashMountToken(String(token).trim());
	if (isSameHash(hash, mount.tokenHash)) return "current";
	if (mount.previousTokenHash && mount.previousUntil && new Date(mount.previousUntil).getTime() > now && isSameHash(hash, mount.previousTokenHash)) return "previous";
	return null;
}
