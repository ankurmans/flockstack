import crypto from "node:crypto";
import { deriveAppKey, deriveAppKeys } from "./app-keys.js";
const KIND = "flockstack-reader-reply-v1";
const signature = (key, id) => crypto.createHmac("sha256", key).update(id).digest("hex").slice(0, 24);
export function getReplyAddress(message) {
	const domain = process.env.REPLIES_DOMAIN;
	if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(domain ?? "")) return null;
	const id = String(message._id);
	return `r-${id}-${signature(deriveAppKey(KIND), id)}@${domain.toLowerCase()}`;
}
export function readReplyAddress(address) {
	const match = /^r-([a-f0-9]{24})-([a-f0-9]{24})@(.+)$/i.exec(address ?? "");
	if (!match || match[3].toLowerCase() !== process.env.REPLIES_DOMAIN?.toLowerCase()) return null;
	const [, id, sig] = match;
	return deriveAppKeys(KIND).some((key) => crypto.timingSafeEqual(Buffer.from(signature(key, id.toLowerCase())), Buffer.from(sig.toLowerCase()))) ? id.toLowerCase() : null;
}
