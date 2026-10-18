import { createContactToken, verifyContactToken } from "./contact-token.js";

// The "You might also like" step proves the reader just subscribed, or confirmed, to the newsletter that recommends: a signed
// token for their contact. Its own key, so no other link can stand in for it. It expires with the page they're on.
const INFO = "flockstack-recommend-v1";
const MAX_AGE_MS = 2 * 60 * 60 * 1000;

export function createRecommendToken({ contactId, newsletterId }, now = Date.now()) {
	return createContactToken({ info: INFO, contactId, newsletterId }, now);
}

export function verifyRecommendToken(token, now = Date.now()) {
	return verifyContactToken(token, { info: INFO, maxAgeMs: MAX_AGE_MS, now });
}
