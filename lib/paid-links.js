import { isSignedWithAppKey, signWithAppKey } from "./app-keys.js";

// Links for pledgers and gift buyers and recipients, who are not always contacts: base64url JSON { k: kind, ...fields, t: seconds }
// + "." + HMAC-SHA256. Each kind signs with a key of its own (like lib/contact-token.js), so a gift link can never cancel a pledge.
const DAY_MS = 86_400_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,500}\.[A-Za-z0-9_-]{43}$/;
const KINDS = {
	// In the pledge emails; an old one still works while the pledge does.
	"pledge-cancel": { info: "flockstack-pledge-cancel-v1", maxAgeMs: 3 * 365 * DAY_MS },
	// In the gift email: a gift can be redeemed for a year from its purchase (lib/gift-rules.js), plus the wait before delivery.
	"gift-redeem": { info: "flockstack-gift-redeem-v1", maxAgeMs: 800 * DAY_MS },
	// In the buyer's receipt: where the gifts they bought are listed.
	"gift-buyer": { info: "flockstack-gift-buyer-v1", maxAgeMs: 3 * 365 * DAY_MS },
};

export function createPaidToken(kind, fields, now = Date.now()) {
	const payload = Buffer.from(JSON.stringify({ ...fields, k: kind, t: Math.floor(now / 1000) })).toString("base64url");
	return `${payload}.${signWithAppKey(KINDS[kind].info, payload)}`;
}

// The fields the token was made with, or null for one that is forged, of another kind or too old.
export function readPaidToken(kind, token, now = Date.now()) {
	if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return null;
	const [payload, signature] = token.split(".");
	if (!isSignedWithAppKey(KINDS[kind].info, payload, signature)) return null;
	try {
		const { k, t, ...fields } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
		if (k !== kind || !Number.isInteger(t) || now - t * 1000 > KINDS[kind].maxAgeMs) return null;
		return fields;
	} catch {
		return null;
	}
}
