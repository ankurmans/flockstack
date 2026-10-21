import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

export const ACTIVITY_STATUSES = ["ok", "failed", "denied", "approval_required", "proposed", "approved", "rejected", "expired", "executed", "execution_failed"];

// What an API key or a connected app did that changed something or touched contact data, and what happened to the
// approvals it asked for (lib/agent-activity.js). Ids, names and counts only: never a body or an address. Kept 90 days.
const agentActivitySchema = new mongoose.Schema(
	{
		kind: { type: String, enum: ["call", "approval"], required: true },
		actorType: { type: String, enum: ["key", "app"], required: true },
		actorId: { type: String, required: true },
		actorName: { type: String, required: true },
		via: { type: String, enum: ["api", "mcp"] },
		action: { type: String, required: true },
		className: { type: String },
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter" },
		status: { type: String, enum: ACTIVITY_STATUSES, required: true },
		errorCode: { type: String },
		summary: { type: String, required: true },
		requestId: { type: String },
		approvalId: { type: mongoose.Schema.Types.ObjectId },
	},
	{ timestamps: true }
);

agentActivitySchema.plugin(accountScoped);
agentActivitySchema.index({ accountId: 1, createdAt: -1 });
agentActivitySchema.index({ accountId: 1, actorId: 1, createdAt: -1 });
agentActivitySchema.index({ createdAt: 1 });

export default mongoose.models.AgentActivity || mongoose.model("AgentActivity", agentActivitySchema);
