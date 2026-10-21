import crypto from "node:crypto";
import { normalizePreset } from "@/lib/action-scopes";
import { getRegion } from "@/lib/region";

// A key is its region's prefix and 43 characters of base64url: mc_ on the US Worker (every key made before regions),
// mc_eu_ on the EU one. The lengths differ (46 and 49), so a US key never reads as an EU one. A key only opens the
// Worker of its own region, whose database holds its hash.
const KEY_PREFIXES = { us: "mc_", eu: "mc_eu_" };
const API_KEY_PATTERN = /^mc_(?:eu_)?[A-Za-z0-9_-]{43}$/;

// For secret scanners and log filters, as docs/authentication gives it: a key anywhere in text, not part of a longer run.
export const API_KEY_SCAN_REGEX = String.raw`(?<![A-Za-z0-9_-])mc_(?:eu_)?[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])`;
const LAST_USED_RESOLUTION_MS = 60_000;

// Only the SHA-256 hash is stored: a database leak doesn't leak usable keys.
export function hashApiKey(key) {
	return crypto.createHash("sha256").update(String(key)).digest("hex");
}

export function generateApiKey(region = getRegion()) {
	const start = KEY_PREFIXES[region] ?? KEY_PREFIXES.us;
	const key = `${start}${crypto.randomBytes(32).toString("base64url")}`;
	return { key, prefix: `${key.slice(0, start.length + 7)}…`, hash: hashApiKey(key) };
}

export function getKeyRegion(key) {
	if (!API_KEY_PATTERN.test(String(key))) return null;
	return String(key).length === KEY_PREFIXES.eu.length + 43 ? "eu" : "us";
}

export function readBearerToken(authorization) {
	const match = /^Bearer\s+(\S+)$/i.exec(String(authorization ?? "").trim());
	return match && API_KEY_PATTERN.test(match[1]) ? match[1] : null;
}

export function shouldTouchLastUsed(lastUsedAt, now = Date.now()) {
	if (!lastUsedAt) return true;
	return now - new Date(lastUsedAt).getTime() >= LAST_USED_RESOLUTION_MS;
}

// The key's level (lib/action-scopes.js PRESETS). Anything without an explicit one, keys from before levels included, can
// only add contacts.
export function getKeyLevel(apiKey) {
	return normalizePreset(apiKey?.level);
}

// A key past its expiry answers unauthorized, like a revoked one.
export function isKeyExpired(apiKey, now = Date.now()) {
	return Boolean(apiKey?.expiresAt) && new Date(apiKey.expiresAt).getTime() <= now;
}
