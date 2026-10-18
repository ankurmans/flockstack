// Stripe signs every webhook as "t=<seconds>,v1=<hex>[,v1=<hex>]": HMAC-SHA256 of "<t>.<body>" with the endpoint's secret.
// WebCrypto only: a Worker has no node:crypto createVerify. A timestamp further than 5 minutes from now is refused, so a
// captured event can't be sent again later.
const TOLERANCE_SECONDS = 5 * 60;
const encoder = new TextEncoder();

function toHex(bytes) {
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sign(secret, message) {
	const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message))));
}

function isEqual(left, right) {
	if (left.length !== right.length) return false;
	let difference = 0;
	for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
	return difference === 0;
}

// The header value Stripe would send, for tests and the local check. timestamp is in seconds.
export async function signStripePayload({ secret, body, timestamp }) {
	return `t=${timestamp},v1=${await sign(secret, `${timestamp}.${body}`)}`;
}

export async function verifyStripeSignature({ body, header, secret, now = Date.now() }) {
	if (!secret || !header) return false;
	let timestamp = null;
	const signatures = [];
	for (const part of header.split(",")) {
		const [name, value] = part.split("=");
		if (name === "t") timestamp = value;
		else if (name === "v1" && value) signatures.push(value);
	}
	const seconds = Number(timestamp);
	if (!timestamp || !Number.isFinite(seconds) || signatures.length === 0) return false;
	if (Math.abs(now / 1000 - seconds) > TOLERANCE_SECONDS) return false;
	const expected = await sign(secret, `${timestamp}.${body}`);
	return signatures.some((signature) => isEqual(signature, expected));
}
