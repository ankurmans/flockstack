import { WorkerEntrypoint } from "cloudflare:workers";
import { isAllowedOrigin } from "./origin.js";
export { CampaignRoom } from "./room.js";
export function roomNamespace(env) { return env.FLOCKSTACK_REGION === "eu" ? env.ROOMS.jurisdiction("eu") : env.ROOMS; }
const collaborationWorker = {
	async fetch(request, env) {
		if (env.COLLABORATION_ENABLED !== "true" || new URL(request.url).pathname !== "/api/collaboration/socket") return new Response("Collaborative editing is unavailable", { status: 503 });
		if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket required", { status: 426 });
		if (!isAllowedOrigin(request.headers.get("origin"), env)) return new Response("Forbidden", { status: 403 });
		const protocols = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map(part => part.trim());
		const tickets = protocols.filter(part => part.startsWith("ticket."));
		if (!protocols.includes("flockstack-collaboration") || tickets.length !== 1 || tickets[0].length > 2010) return new Response("Forbidden", { status: 403 });
		try {
			const current = await env.AUTHORITY.inspectTicket(tickets[0].slice(7)), reference = current.reference;
			const stub = roomNamespace(env).getByName(`${reference.accountId}/${reference.campaignId}`);
			return stub.fetch(new Request("https://editor.internal/api/collaboration/socket", { headers: { upgrade: "websocket", "x-fs-editor-reference": JSON.stringify(reference) } }));
		} catch { return new Response("Editing access unavailable", { status: 403 }); }
	},
};
export default collaborationWorker;
// Reachable only through a service binding, for account export/purge housekeeping. Never an HTTP endpoint.
export class CollaborationStorage extends WorkerEntrypoint {
	async notifyThreads(accountId, campaignId) {
		if (!/^[a-f0-9]{24}$/.test(accountId) || !/^[a-f0-9]{24}$/.test(campaignId)) throw new Error("Invalid editor notification target");
		await roomNamespace(this.env).getByName(`${accountId}/${campaignId}`).notifyEditorial();
	}
	async purgeRooms(accountId, campaignIds) {
		if (!/^[a-f0-9]{24}$/.test(accountId) || !Array.isArray(campaignIds) || campaignIds.length > 100 || campaignIds.some(id => !/^[a-f0-9]{24}$/.test(id))) throw new Error("Invalid editor cleanup target");
		for (const campaignId of campaignIds) await roomNamespace(this.env).getByName(`${accountId}/${campaignId}`).purge();
		return { purged: campaignIds.length };
	}
}
