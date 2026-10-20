// Outgoing events are signed with the Standard Webhooks scheme (standardwebhooks.com), the one Polar's events use
// (lib/polar-webhook.js): HMAC-SHA256 over "<webhook-id>.<webhook-timestamp>.<body>", keyed with the base64 after
// "whsec_", sent as "v1,<base64>". Any Standard Webhooks library verifies them. WebCrypto only, for Workers.
export const SECRET_PREFIX = "whsec_";
const SECRET_BYTES = 32;
const encoder = new TextEncoder();

function toBase64(bytes) {
	return btoa(String.fromCharCode(...bytes));
}

function fromBase64(value) {
	return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

export function generateWebhookSecret() {
	return `${SECRET_PREFIX}${toBase64(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)))}`;
}

async function hmac(secret, message) {
	const keyBytes = fromBase64(secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret);
	const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

// The webhook-signature header: one "v1,<base64>" per secret, space separated. While a rotated secret is still honored,
// both are there, so the receiver can switch to the new one at its own pace. timestamp in seconds.
export async function signWebhook({ secrets, id, timestamp, body }) {
	const signatures = await Promise.all(secrets.map(async (secret) => `v1,${toBase64(await hmac(secret, `${id}.${timestamp}.${body}`))}`));
	return signatures.join(" ");
}

// The three headers of a delivery.
export async function getWebhookHeaders({ secrets, id, body, now = Date.now() }) {
	const timestamp = String(Math.floor(now / 1000));
	return {
		"webhook-id": id,
		"webhook-timestamp": timestamp,
		"webhook-signature": await signWebhook({ secrets, id, timestamp, body }),
	};
}
