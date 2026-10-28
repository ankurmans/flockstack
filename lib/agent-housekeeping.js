import "server-only";
import { purgeAgentActivity } from "@/lib/agent-activity";
import { ACTIVITY_RETENTION_DAYS } from "@/lib/agent-activity-rules";
import { DECIDED_INPUT_DAYS } from "@/lib/approval-rules";
import { RUN_RETENTION_DAYS, SEEN_RETENTION_DAYS, USAGE_RETENTION_DAYS } from "@/lib/briefing-rules";
import { expireDueApprovals } from "@/lib/approvals";
import { connectDb } from "@/lib/db";
import ApprovalRequest from "@/models/ApprovalRequest";

const DELETE_PER_RUN = 2000;

// The hourly cron's part (app/api/cron/hourly): requests nobody decided in 24 hours expire, a week after a request was decided its
// input and result go (they can hold contacts' addresses; the hash and the summary stay), and the activity log, the daily counts
// and the requests themselves go after 90 days, as do briefing runs; what a briefing has seen goes after 30, and the pacing counters of search keys after 2. Each step is bounded so D1's size cap and the cron's time limit hold; what is
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
	await (await import("@/models/AgentWorkspace")).default.deleteMany({ expiresAt: { $lt: now } }).setOptions({ limit: DELETE_PER_RUN });
	await (await import("@/models/Reply")).default.deleteMany({ createdAt: { $lt: new Date(+now - 90 * 86400000) } }).setOptions({ crossAccount: true, limit: DELETE_PER_RUN });
	await (await import("@/models/IssueTranslation")).default.deleteMany({ expiresAt: { $lt: now } }).setOptions({ crossAccount: true, limit: DELETE_PER_RUN });
	await (await import("@/models/MeteredRead")).default.deleteMany({ expiresAt: { $lt: now } }).setOptions({ crossAccount: true, limit: DELETE_PER_RUN });
	const runsDeleted = await (await import("@/models/BriefingRun")).default.deleteMany({ createdAt: { $lt: new Date(+now - RUN_RETENTION_DAYS * 86_400_000) } }).setOptions({ crossAccount: true, limit: DELETE_PER_RUN });
	const seenDeleted = await (await import("@/models/BriefingSeen")).default.deleteMany({ firstSeenAt: { $lt: new Date(+now - SEEN_RETENTION_DAYS * 86_400_000) } }).setOptions({ crossAccount: true, limit: DELETE_PER_RUN });
	const usageDeleted = await (await import("@/models/DiscoveryUsage")).default.deleteMany({ windowStart: { $lt: new Date(+now - USAGE_RETENTION_DAYS * 86_400_000) } }).setOptions({ crossAccount: true, limit: DELETE_PER_RUN });
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
	return { expired, scrubbed: scrubbed.modifiedCount ?? 0, approvalsDeleted: deleted.deletedCount ?? 0, briefingRunsDeleted: runsDeleted.deletedCount ?? 0, briefingSeenDeleted: seenDeleted.deletedCount ?? 0, discoveryUsageDeleted: usageDeleted.deletedCount ?? 0, ...(await purgeAgentActivity(now)) };
}
