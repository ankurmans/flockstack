import { signWithAppKey, isSignedWithAppKey } from "./app-keys.js";
const INFO = "flockstack-campaign-collaboration-v1";
export function createCollaborationTicket(reference, now = Date.now()) {
	const payload = Buffer.from(JSON.stringify({ ...reference, issuedAt: now })).toString("base64url");
	return `${payload}.${signWithAppKey(INFO, payload)}`;
}
export function readCollaborationTicket(token, now = Date.now()) {
	if (typeof token !== "string" || token.length > 2000 || !/^[\w-]+\.[\w-]{43}$/.test(token)) return null;
	const [payload, signature] = token.split(".");
	if (!isSignedWithAppKey(INFO, payload, signature)) return null;
	try { const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); if (!Number.isSafeInteger(value.issuedAt) || value.issuedAt > now + 5000 || now - value.issuedAt > 60000) return null; return value; } catch { return null; }
}
