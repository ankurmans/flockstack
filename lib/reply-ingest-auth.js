import crypto from "node:crypto";
export function signReplyIngest(secret, timestamp, body) { return crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex"); }
export function verifyReplyIngest(header, body, now = Date.now()) {
	const match = /^(\d{13})\.([a-f0-9]{64})$/.exec(header ?? "");
	if (!match || Math.abs(now - Number(match[1])) > 300000) return false;
	return [process.env.REPLY_INGEST_SECRET, process.env.REPLY_INGEST_SECRET_PREVIOUS].filter(Boolean).some((secret) => crypto.timingSafeEqual(Buffer.from(signReplyIngest(secret, match[1], body)), Buffer.from(match[2])));
}
