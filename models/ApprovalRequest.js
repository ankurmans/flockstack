import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "expired"];
export const EXECUTION_STATES = ["none", "running", "done", "failed"];

// An action an agent asked to run and a person has to approve first (lib/approvals.js). The input is stored exactly as
// proposed and never changes: inputHash covers it, and the action that runs on approval is built from it. Once decided
// the input and the result are kept for a week (lib/agent-housekeeping.js), the hash and the summary for 90 days.
const approvalRequestSchema = new mongoose.Schema(
	{
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter" },
		// Who asked: an API key or an app connected with OAuth, as it was named then.
		actorType: { type: String, enum: ["key", "app"], required: true },
		actorId: { type: String, required: true },
		actorName: { type: String, required: true },
		preset: { type: String, required: true },
		// briefing: a briefing that sends by itself (lib/briefings-delivery.js), as an app named after the briefing.
		via: { type: String, enum: ["api", "mcp", "briefing"], required: true },
		action: { type: String, required: true },
		className: { type: String, required: true },
		// Why it wasn't run: the key's level, the newsletter's setting, or the size of the change.
		reason: { type: String, enum: ["key", "newsletter", "scale"], required: true },
		input: { type: mongoose.Schema.Types.Mixed },
		inputHash: { type: String, required: true },
		summary: { type: String, required: true },
		preview: { type: mongoose.Schema.Types.Mixed },
		// What the action's target looked like when it was proposed, to notice a change before it runs.
		fingerprint: { type: mongoose.Schema.Types.Mixed },
		requestId: { type: String },
		status: { type: String, enum: APPROVAL_STATUSES, default: "pending" },
		// Set only while pending: a second identical request from the same caller finds the first instead of a copy.
		pendingKey: { type: String },
		expiresAt: { type: Date, required: true },
		decidedAt: { type: Date },
		decidedBy: { type: String },
		note: { type: String },
		execution: {
			state: { type: String, enum: EXECUTION_STATES, default: "none" },
			at: { type: Date },
			result: { type: mongoose.Schema.Types.Mixed },
			errorCode: { type: String },
			errorMessage: { type: String },
		},
		scrubbedAt: { type: Date },
	},
	{ timestamps: true }
);

approvalRequestSchema.plugin(accountScoped);
approvalRequestSchema.index({ accountId: 1, status: 1, createdAt: -1 });
approvalRequestSchema.index({ accountId: 1, actorId: 1, createdAt: -1 });
approvalRequestSchema.index({ pendingKey: 1 }, { unique: true, sparse: true });
approvalRequestSchema.index({ status: 1, expiresAt: 1 });
approvalRequestSchema.index({ createdAt: 1 });

export default mongoose.models.ApprovalRequest || mongoose.model("ApprovalRequest", approvalRequestSchema);
