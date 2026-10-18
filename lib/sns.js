// Exactly sns.<region>.amazonaws.com: a looser pattern also matched S3 bucket hosts like sns.s3.amazonaws.com.
const AWS_SNS_HOST = /^sns\.[a-z]{2}(?:-[a-z]+)+-\d+\.amazonaws\.com$/;
const SIGNING_CERT_PATH = /^\/SimpleNotificationService-[a-z0-9]+\.pem$/i;
const SIGNATURE_ALGORITHMS = new Map([
	["1", "SHA-1"],
	["2", "SHA-256"],
]);
const SUBSCRIPTION_KEYS = ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
// AWS spec: keys in byte order, Subject only when the notification has one.
const SIGNED_KEYS = new Map([
	["Notification", ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"]],
	["SubscriptionConfirmation", SUBSCRIPTION_KEYS],
	["UnsubscribeConfirmation", SUBSCRIPTION_KEYS],
]);
const OPTIONAL_KEYS = new Set(["Subject"]);
const MAX_CACHED_CERTIFICATES = 20;
const PEM_PATTERN = /-----BEGIN (CERTIFICATE|PUBLIC KEY)-----/;

function parseAwsSnsUrl(value) {
	if (typeof value !== "string") return null;
	try {
		const url = new URL(value);
		const isAws =
			url.protocol === "https:" &&
			AWS_SNS_HOST.test(url.hostname) &&
			!url.port &&
			!url.username &&
			!url.password;
		return isAws ? url : null;
	} catch {
		return null;
	}
}

export function isValidSigningCertUrl(value) {
	const url = parseAwsSnsUrl(value);
	return Boolean(url && SIGNING_CERT_PATH.test(url.pathname) && !url.search && !url.hash);
}

export function isValidSubscribeUrl(value) {
	return Boolean(parseAwsSnsUrl(value));
}

export function buildSigningString(message) {
	const keys = SIGNED_KEYS.get(message?.Type);
	if (!keys) return null;

	let signingString = "";
	for (const key of keys) {
		const value = Object.hasOwn(message, key) ? message[key] : undefined;
		if (value == null && OPTIONAL_KEYS.has(key)) continue;
		if (typeof value !== "string") return null;
		signingString += `${key}\n${value}\n`;
	}
	return signingString;
}

function base64ToBytes(base64) {
	return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

// One DER element: where its content starts and ends.
function readDer(bytes, offset) {
	let length = bytes[offset + 1];
	let header = 2;
	if (length & 0x80) {
		const count = length & 0x7f;
		length = 0;
		for (let index = 0; index < count; index++) length = length * 256 + bytes[offset + 2 + index];
		header = 2 + count;
	}
	return { tag: bytes[offset], offset, start: offset + header, end: offset + header + length };
}

// The public key inside an X.509 certificate, as the SPKI WebCrypto imports: the sixth item of the certificate's
// body after the optional version (serial, signature algorithm, issuer, validity, subject, then the key).
export function getPublicKeyBytes(pem) {
	const der = base64ToBytes(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""));
	if (/BEGIN PUBLIC KEY/.test(pem)) return der;
	const certificate = readDer(der, 0);
	let item = readDer(der, readDer(der, certificate.start).start);
	if (item.tag === 0xa0) item = readDer(der, item.end);
	for (let skipped = 0; skipped < 5; skipped++) item = readDer(der, item.end);
	return der.slice(item.offset, item.end);
}

// WebCrypto rather than node:crypto: it's the same in Node and on Workers, where createVerify can't read a certificate.
async function verifySignature(hash, pem, signingString, signature) {
	const key = await crypto.subtle.importKey("spki", getPublicKeyBytes(pem), { name: "RSASSA-PKCS1-v1_5", hash }, false, ["verify"]);
	return crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, base64ToBytes(signature), new TextEncoder().encode(signingString));
}

async function fetchAwsCertificate(url) {
	// "manual", not "error": Workers' fetch doesn't take "error", and a redirect is refused all the same.
	const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5000) });
	if (!response.ok) throw new Error(`Certificate request failed with ${response.status}`);
	return response.text();
}

export function createSnsVerifier({ fetchCertificate = fetchAwsCertificate } = {}) {
	const certificates = new Map();

	function getCertificate(url) {
		if (!certificates.has(url)) {
			if (certificates.size >= MAX_CACHED_CERTIFICATES) certificates.clear();
			const pending = Promise.resolve(url)
				.then(fetchCertificate)
				.then((pem) => {
					if (!PEM_PATTERN.test(String(pem))) throw new Error("Certificate is not PEM");
					return String(pem);
				});
			certificates.set(url, pending);
			pending.catch(() => certificates.delete(url));
		}
		return certificates.get(url);
	}

	return async function verifySnsMessage(message) {
		const algorithm = SIGNATURE_ALGORITHMS.get(message?.SignatureVersion);
		const signingString = buildSigningString(message);
		if (!algorithm || !signingString || typeof message.Signature !== "string") return false;
		if (!isValidSigningCertUrl(message.SigningCertURL)) return false;

		try {
			const certificate = await getCertificate(message.SigningCertURL);
			return await verifySignature(algorithm, certificate, signingString, message.Signature);
		} catch {
			return false;
		}
	};
}

export const verifySnsMessage = createSnsVerifier();
