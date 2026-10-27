import PostalMime from "postal-mime";
import crypto from "node:crypto";
import { signReplyIngest } from "../../lib/reply-ingest-auth.js";
const repliesWorker = {
	async email(message, env) {
		if (!env.APP || !env.REPLY_INGEST_SECRET) throw new Error("Reply inbox is not configured");
		if (message.rawSize > 1024 * 1024) { message.setReject("Replies must be under 1 MB"); return; }
		const raw = await new Response(message.raw).arrayBuffer();
		const parsed = await PostalMime.parse(raw);
		const body = JSON.stringify({ to: message.to, from: message.from, externalId: parsed.messageId || crypto.createHash("sha256").update(Buffer.from(raw)).digest("hex"), subject: String(parsed.subject ?? "").slice(0, 300), text: String(parsed.text ?? "").slice(0, 30000) });
		const timestamp = String(Date.now());
		// The service binding chooses the Worker; localhost keeps its middleware on the app host, not a customer archive.
		const response = await env.APP.fetch("https://localhost/api/inbound-replies", { method: "POST", headers: { host: "localhost", "content-type": "application/json", "x-flockstack-reply": `${timestamp}.${signReplyIngest(env.REPLY_INGEST_SECRET, timestamp, body)}` }, body });
		if (response.status === 404 || response.status === 400) { message.setReject("Reply address not available"); return; }
		if (!response.ok) throw new Error("Reply inbox temporarily unavailable");
	},
};
export default repliesWorker;
