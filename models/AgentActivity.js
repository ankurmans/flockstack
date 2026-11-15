import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

export const ACTIVITY_STATUSES = ["ok", "failed", "denied", "approval_required", "proposed", "approved", "rejected", "expired", "executed", "execution_failed"];

export const ACTIVITY_KINDS = ["call", "approval", "setting"];
export const ACTOR_TYPES = ["key", "app", "person"];
export const ACTIVITY_VIAS = ["api", "mcp", "briefing", "dashboard"];

// What an API key or a connected app did that changed something or touched contact data, what happened to the approvals
// it asked for, what a team member changed in the dashboard, and the owner's changes to how agents are held (lib/agent-activity.js).
// Ids, names and counts only: never a body or an address. Kept the account's retention (90 days unless the owner chose).
const agentActivitySchema = new mongoose.Schema(
	{
		kind: { type: String, enum: ACTIVITY_KINDS, required: true },
		actorType: { type: String, enum: ACTOR_TYPES, required: true },
		actorId: { type: String, required: true },
		actorName: { type: String, required: true },
		via: { type: String, enum: ACTIVITY_VIAS },
		action: { type: String, required: true },
		className: { type: String },
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter" },
		status: { type: String, enum: ACTIVITY_STATUSES, required: true },
		errorCode: { type: String },
		summary: { type: String, required: true },
		requestId: { type: String },
		approvalId: { type: mongoose.Schema.Types.ObjectId },
		// The account's retention when it was written; none is 90 (lib/agent-activity.js purgeAgentActivity).
		keepDays: { type: Number },
	},
	{ timestamps: true }
);

agentActivitySchema.plugin(accountScoped);
agentActivitySchema.index({ accountId: 1, createdAt: -1 });
agentActivitySchema.index({ accountId: 1, actorId: 1, createdAt: -1 });
agentActivitySchema.index({ accountId: 1, actorName: 1, createdAt: -1 });
agentActivitySchema.index({ createdAt: 1 });

export default mongoose.models.AgentActivity || mongoose.model("AgentActivity", agentActivitySchema);
