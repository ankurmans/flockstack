import "server-only";
import { purgeAgentActivity } from "@/lib/agent-activity";
import { ACTIVITY_RETENTION_DAYS } from "@/lib/agent-activity-rules";
import { DECIDED_INPUT_DAYS } from "@/lib/approval-rules";
import { expireDueApprovals } from "@/lib/approvals";
import { connectDb } from "@/lib/db";
import ApprovalRequest from "@/models/ApprovalRequest";

const DELETE_PER_RUN = 2000;

// The hourly cron's part (app/api/cron/hourly): requests nobody decided in 24 hours expire, a week after a request was decided its
// input and result go (they can hold contacts' addresses; the hash and the summary stay), and the activity log, the daily counts
// and the requests themselves go after 90 days. Each step is bounded so D1's size cap and the cron's time limit hold; what is
// left waits for the next hour.
export async function runAgentHousekeeping(now = new Date()) {
	try {
		return await sweep(now);
	} catch (error) {
		console.error("[agent-housekeeping] Failed:", error?.message);
		return { failed: error?.message ?? "failed" };
	}
}

async function sweep(now) {
	await connectDb();
	const expired = await expireDueApprovals(now);
	const scrubCutoff = new Date(now.getTime() - (DECIDED_INPUT_DAYS + 1) * 86_400_000);
	const scrubbed = await ApprovalRequest.updateMany(
		{ status: { $ne: "pending" }, createdAt: { $lt: scrubCutoff }, scrubbedAt: null },
		{ $set: { scrubbedAt: now }, $unset: { input: 1, "execution.result": 1 } }
	)
		.setOptions({ crossAccount: true });
	const deleted = await ApprovalRequest.deleteMany({ createdAt: { $lt: new Date(now.getTime() - ACTIVITY_RETENTION_DAYS * 86_400_000) } }).setOptions({
		crossAccount: true,
		limit: DELETE_PER_RUN,
	});
	return { expired, scrubbed: scrubbed.modifiedCount ?? 0, approvalsDeleted: deleted.deletedCount ?? 0, ...(await purgeAgentActivity(now)) };
}
