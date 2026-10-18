import { createContactToken, verifyContactToken } from "./contact-token.js";

// The "Manage your subscription" link in a paid subscriber's emails: it opens the Stripe customer portal for them, where they
// update their card, see invoices or cancel. Signed for one contact, with a key of its own (lib/contact-token.js).
const INFO = "flockstack-billing-portal-v1";
// Old emails keep working while the person is still a subscriber.
const MAX_AGE_MS = 400 * 86_400_000;

export function getPortalUrl({ contactId, newsletterId }, baseUrl, now = Date.now()) {
	return `${baseUrl}/api/shop/portal?token=${createContactToken({ info: INFO, contactId, newsletterId }, now)}`;
}

export function readPortalToken(token, now = Date.now()) {
	return verifyContactToken(token, { info: INFO, maxAgeMs: MAX_AGE_MS, now });
}
