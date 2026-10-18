import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

// draft: being written. active: contacts enter and move along. paused: nobody enters, nobody moves; they continue
// where they were when it's active again. deleted: gone from the lists, kept in the database like every customer document.
export const AUTOMATION_STATUSES = ["draft", "active", "paused", "deleted"];

// A series of emails and actions started by something that happens to a contact (lib/automation-rules.js has the
// shapes of trigger and steps, lib/automations.js runs it).
const automationSchema = new mongoose.Schema(
	{
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		name: { type: String, required: true, trim: true },
		status: { type: String, enum: AUTOMATION_STATUSES, default: "draft" },
		trigger: { type: mongoose.Schema.Types.Mixed, required: true },
		steps: { type: mongoose.Schema.Types.Mixed, required: true },
		// Why it paused itself, when it did: a problem with its emails that the owner has to fix.
		pauseReason: { type: String },
		activatedAt: { type: Date },
		pausedAt: { type: Date },
		// The scheduled triggers (a segment joined, a date field) are looked at from time to time, not at once:
		// when they last were, and where a pass over a big segment stopped.
		lastEvaluatedAt: { type: Date },
		evaluationCursor: { type: String },
		// A segment trigger set to leave out the contacts already in the segment records them the first time it looks.
		baselineAt: { type: Date },
		source: { type: String, default: "dashboard" },
	},
	{ timestamps: true }
);

automationSchema.plugin(accountScoped);
automationSchema.index({ newsletterId: 1, createdAt: -1 });
// The job looks at every active automation, whatever its account.
automationSchema.index({ status: 1 });

export default mongoose.models.Automation || mongoose.model("Automation", automationSchema);
