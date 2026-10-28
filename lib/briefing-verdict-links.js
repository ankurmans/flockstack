import { randomBytes } from "node:crypto";
import { isSignedWithAppKey, signWithAppKey } from "./app-keys.js";
import { VERDICTS, VERDICT_LINK_DAYS } from "./briefing-rules.js";
import { isObjectIdString } from "./validation.js";

// The keep and drop links in a briefing's note to the owner (docs/BRIEFINGS-DESIGN.md, Actions): the run, the story, the verdict and
// a random link id, signed with a key of their own from BETTER_AUTH_SECRET (lib/app-keys.js), for VERDICT_LINK_DAYS. A link opens a
// confirmation page (app/briefing-verdict), which records the verdict only when its button is pressed, and then only once: the
// link id is unique on the verdict it recorded. base64url JSON + "." + HMAC.
const INFO = "flockstack-briefing-verdict-v1";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,600}\.[A-Za-z0-9_-]{43}$/;
const STORY_KEY_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const LINK_ID_PATTERN = /^[A-Za-z0-9_-]{16,32}$/;
export const VERDICT_LINK_MS = VERDICT_LINK_DAYS * 86_400_000;

export function createVerdictToken({ accountId, runId, storyKey, verdict }, now = Date.now()) {
	if (!isObjectIdString(String(accountId)) || !isObjectIdString(String(runId)) || !STORY_KEY_PATTERN.test(String(storyKey)) || !VERDICTS.includes(verdict)) {
		throw new Error("A verdict link needs an account, a run, a story key and keep or drop");
	}
	const data = { a: String(accountId), r: String(runId), s: String(storyKey), v: verdict, l: randomBytes(12).toString("base64url"), e: Math.floor((now + VERDICT_LINK_MS) / 1000) };
	const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
	return `${payload}.${signWithAppKey(INFO, payload)}`;
}

// { accountId, runId, storyKey, verdict, linkId, expiresAt }, or null for a link that is not one of ours, was changed or has expired.
export function verifyVerdictToken(token, now = Date.now()) {
	if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return null;
	const [payload, signature] = token.split(".");
	if (!isSignedWithAppKey(INFO, payload, signature)) return null;
	try {
		const { a, r, s, v, l, e } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
		if (!isObjectIdString(a) || !isObjectIdString(r) || !STORY_KEY_PATTERN.test(s ?? "") || !VERDICTS.includes(v) || !LINK_ID_PATTERN.test(l ?? "")) return null;
		if (!Number.isInteger(e) || e * 1000 < now) return null;
		return { accountId: a, runId: r, storyKey: s, verdict: v, linkId: l, expiresAt: new Date(e * 1000) };
	} catch {
		return null;
	}
}

export function getVerdictLinkUrl(appUrl, token) {
	return `${String(appUrl).replace(/\/+$/, "")}/briefing-verdict/${token}`;
}
