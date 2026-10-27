import "server-only";
import { scoped } from "@/lib/account-scope";
import { connectDb } from "@/lib/db";
import CampaignCollaboration from "@/models/CampaignCollaboration";
export const COLLABORATION_HISTORY_DAYS = 30;
export async function expireCollaborationSnapshots(now = new Date()) {
	try {
		await connectDb(); const cutoff = new Date(+now - COLLABORATION_HISTORY_DAYS * 86400000);
		const rows = await CampaignCollaboration.find({ checkpointAt: { $lt: cutoff } }).setOptions({ crossAccount: true }).limit(100).lean();
		if (!rows.length) return { deleted: 0 };
		const { getCloudflareContext } = await import("@opennextjs/cloudflare"), storage = (await getCloudflareContext({ async: true })).env?.COLLABORATION_STORAGE;
		if (!storage) return { deleted: 0, cleanupUnavailable: true };
		let deleted = 0;
		for (const row of rows) {
			await storage.purgeRooms(String(row.accountId), [String(row.campaignId)]);
			const result = await CampaignCollaboration.deleteOne(scoped(row.accountId, { _id: row._id, checkpointAt: { $lt: cutoff } })); deleted += result.deletedCount;
		}
		return { deleted };
	} catch { return { deleted: 0, cleanupUnavailable: true }; }
}
