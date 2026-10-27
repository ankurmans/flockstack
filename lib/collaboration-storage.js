import "server-only";
import { scoped } from "@/lib/account-scope";
import CampaignCollaboration from "@/models/CampaignCollaboration";
async function binding() {
	try { const { getCloudflareContext } = await import("@opennextjs/cloudflare"); return (await getCloudflareContext({ async: true })).env?.COLLABORATION_STORAGE ?? null; } catch { return null; }
}
export async function notifyEditorThreads(account, campaignId) {
	const storage = await binding();
	if (storage) await storage.notifyThreads(String(account._id ?? account), String(campaignId));
}
export async function purgeCollaborationRooms(account) {
	let after;
	for (;;) {
		const rows = await CampaignCollaboration.find(scoped(account, { ...(after && { _id: { $gt: after } }) })).sort({ _id: 1 }).limit(100).select("campaignId").lean();
		if (!rows.length) return;
		const storage = await binding();
		if (!storage) throw new Error("The collaboration storage binding is required to remove this account's private editor state");
		await storage.purgeRooms(String(account._id), rows.map(row => String(row.campaignId)));
		after = rows.at(-1)._id;
	}
}
