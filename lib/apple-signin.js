// Sign in with Apple's client secret: Apple takes no fixed secret, only a JWT signed with the key downloaded from Apple
// Developer (a .p8 file, ES256), which Apple refuses once it is more than 6 months old. So it is made here from the key,
// valid for a day, and kept per isolate until an hour before it expires. Everything is read from the environment when
// it is used: one build serves both regions (lib/region.js).
export const APPLE_AUDIENCE = "https://appleid.apple.com";
export const APPLE_SECRET_SECONDS = 24 * 3600;
const RENEW_BEFORE_SECONDS = 3600;

let cached = null;
let pending = null;

export function isAppleEnabled() {
	return Boolean(process.env.APPLE_CLIENT_ID && process.env.APPLE_TEAM_ID && process.env.APPLE_KEY_ID && process.env.APPLE_PRIVATE_KEY);
}

function readConfig() {
	return {
		clientId: process.env.APPLE_CLIENT_ID,
		teamId: process.env.APPLE_TEAM_ID,
		keyId: process.env.APPLE_KEY_ID,
		privateKey: process.env.APPLE_PRIVATE_KEY,
	};
}

function sameConfig(a, b) {
	return a.clientId === b.clientId && a.teamId === b.teamId && a.keyId === b.keyId && a.privateKey === b.privateKey;
}

function base64url(bytes) {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const encodeJson = (value) => base64url(new TextEncoder().encode(JSON.stringify(value)));

// The .p8 file as it is, or pasted into one line with literal \n where its line breaks were.
function readPkcs8(pem) {
	const body = pem
		.replace(/\\n/g, "\n")
		.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "")
		.replace(/\s+/g, "");
	const binary = atob(body);
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

// WebCrypto's ECDSA signature is r and s side by side, which is what JWS's ES256 expects (not DER).
async function signClientSecret({ clientId, teamId, keyId, privateKey }, issuedAt) {
	const key = await crypto.subtle.importKey("pkcs8", readPkcs8(privateKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
	const expiresAt = issuedAt + APPLE_SECRET_SECONDS;
	const input = `${encodeJson({ alg: "ES256", kid: keyId })}.${encodeJson({ iss: teamId, iat: issuedAt, exp: expiresAt, aud: APPLE_AUDIENCE, sub: clientId })}`;
	const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(input));
	return { token: `${input}.${base64url(new Uint8Array(signature))}`, expiresAt };
}

function isFresh(entry, config, now) {
	return Boolean(entry && sameConfig(entry.config, config) && entry.expiresAt - RENEW_BEFORE_SECONDS > now);
}

// The client secret, signed again once it has less than an hour left or the key changed.
export async function renewAppleClientSecret() {
	const config = readConfig();
	const now = Math.floor(Date.now() / 1000);
	if (isFresh(cached, config, now)) return cached.token;
	pending ??= signClientSecret(config, now)
		.then(({ token, expiresAt }) => {
			cached = { config, token, expiresAt };
			return token;
		})
		.finally(() => {
			pending = null;
		});
	return pending;
}

// Better Auth reads the secret synchronously; renewAppleClientSecret has run before it does (lib/auth.js, getAuth).
export function getAppleClientSecret() {
	return cached && sameConfig(cached.config, readConfig()) ? cached.token : undefined;
}
