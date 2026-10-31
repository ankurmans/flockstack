import { isSignedWithAppKey, signWithAppKey } from "./app-keys.js";
import { PAUSE_LINK_DAYS } from "./briefing-rules.js";
import { isObjectIdString } from "./validation.js";

// The pause link in the note after a briefing sent an issue by itself (docs/BRIEFINGS-DESIGN.md, Auto-send): the briefing and the
// run it follows, signed with a key of its own from BETTER_AUTH_SECRET (lib/app-keys.js), for PAUSE_LINK_DAYS. It opens a
// confirmation page (app/briefing-pause) that pauses the briefing only when its button is pressed, so mail scanners and link previews
// cannot. Pausing twice is harmless, so unlike a verdict link it is not single use. base64url JSON + "." + HMAC.
const INFO = "flockstack-briefing-pause-v1";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,400}\.[A-Za-z0-9_-]{43}$/;
export const PAUSE_LINK_MS = PAUSE_LINK_DAYS * 86_400_000;

export function createPauseToken({ accountId, briefingId, runId }, now = Date.now()) {
	if (![accountId, briefingId, runId].every((id) => isObjectIdString(String(id)))) throw new Error("A pause link needs an account, a briefing and a run");
	const data = { a: String(accountId), b: String(briefingId), r: String(runId), e: Math.floor((now + PAUSE_LINK_MS) / 1000) };
	const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
	return `${payload}.${signWithAppKey(INFO, payload)}`;
}

// { accountId, briefingId, runId, expiresAt }, or null for a link that is not one of ours, was changed or has expired.
export function verifyPauseToken(token, now = Date.now()) {
	if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return null;
	const [payload, signature] = token.split(".");
	if (!isSignedWithAppKey(INFO, payload, signature)) return null;
	try {
		const { a, b, r, e } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
		if (![a, b, r].every((id) => isObjectIdString(id)) || !Number.isInteger(e) || e * 1000 < now) return null;
		return { accountId: a, briefingId: b, runId: r, expiresAt: new Date(e * 1000) };
	} catch {
		return null;
	}
}

export function getPauseLinkUrl(appUrl, token) {
	return `${String(appUrl).replace(/\/+$/, "")}/briefing-pause/${token}`;
}
