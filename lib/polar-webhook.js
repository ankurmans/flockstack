// Polar signs events with the Standard Webhooks scheme: HMAC-SHA256 over "<id>.<timestamp>.<body>", sent as
// "v1,<base64>" (several, space separated, while a secret rotates). WebCrypto only: a Worker has no node:crypto createVerify.
const TOLERANCE_SECONDS = 5 * 60;
const encoder = new TextEncoder();

function decodeBase64(value) {
	return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

// Secrets made from 8 September 2026 are Standard Webhooks': the key is the base64 after "whsec_". Older ones are Polar's
// own: the key is the secret's text as shown. Both are tried, so a secret works whichever side of that date it was made.
function getKeyBytes(secret) {
	const keys = [encoder.encode(secret)];
	try {
		keys.push(decodeBase64(secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret));
	} catch {
		// Not base64: only the text key applies.
	}
	return keys;
}

async function sign(keyBytes, message) {
	const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

function isEqual(left, right) {
	if (left.length !== right.length) return false;
	let difference = 0;
	for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
	return difference === 0;
}

// The signature header value for a body: what Polar sends, for tests and the local check. timestamp is in seconds.
export async function signPolarWebhook({ secret, id, timestamp, body, keyIndex = 0 }) {
	const bytes = await sign(getKeyBytes(secret)[keyIndex], `${id}.${timestamp}.${body}`);
	return `v1,${btoa(String.fromCharCode(...bytes))}`;
}

// headers: the request's Headers. A timestamp further than 5 minutes from now is refused, so a captured event can't be
// sent again later.
export async function verifyPolarWebhook({ body, headers, secret, now = Date.now() }) {
	const id = headers.get("webhook-id");
	const timestamp = headers.get("webhook-timestamp");
	const signatures = headers.get("webhook-signature");
	if (!secret || !id || !timestamp || !signatures) return false;
	const seconds = Number(timestamp);
	if (!Number.isFinite(seconds) || Math.abs(now / 1000 - seconds) > TOLERANCE_SECONDS) return false;

	const message = `${id}.${timestamp}.${body}`;
	const received = [];
	for (const part of signatures.split(" ")) {
		const [version, value] = part.split(",");
		if (version !== "v1" || !value) continue;
		try {
			received.push(decodeBase64(value));
		} catch {
			// A malformed signature next to a good one doesn't spoil it.
		}
	}
	for (const keyBytes of getKeyBytes(secret)) {
		const expected = await sign(keyBytes, message);
		if (received.some((signature) => isEqual(signature, expected))) return true;
	}
	return false;
}
