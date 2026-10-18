import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

export const ENROLLMENT_STATUSES = ["active", "completed", "exited"];
// Why a contact left an automation before its end. baseline: it was already in the segment when the automation
// started and was set to leave those out; it never counts as an enrollment.
export const EXIT_REASONS = ["unsubscribed", "bounced", "complained", "dormant", "suppressed", "undeliverable", "deleted", "failed", "inactive", "baseline"];

// One contact in one automation: where it is, and when it moves on. Its emails are Messages of kind automation.
const enrollmentSchema = new mongoose.Schema(
	{
		automationId: { type: mongoose.Schema.Types.ObjectId, ref: "Automation", required: true },
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		contactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact", required: true },
		// "once", or the year of a date trigger that repeats every year: a contact enters once per cycle.
		cycle: { type: String, default: "once" },
		status: { type: String, enum: ENROLLMENT_STATUSES, default: "active" },
		exitReason: { type: String, enum: EXIT_REASONS },
		trigger: { type: String },
		// The step it runs next. The id survives edits to the steps; the index is where it falls back to.
		stepIndex: { type: Number, default: 0 },
		stepId: { type: String },
		nextRunAt: { type: Date },
		// A run of the job holds it while it works, so two runs never move the same contact.
		lockedUntil: { type: Date },
		emailsSent: { type: Number, default: 0 },
		enrolledAt: { type: Date, default: Date.now },
		completedAt: { type: Date },
		exitedAt: { type: Date },
	},
	{ timestamps: true }
);

enrollmentSchema.plugin(accountScoped);
// No double enrollment, whatever starts two at once.
enrollmentSchema.index({ automationId: 1, contactId: 1, cycle: 1 }, { unique: true });
// What the job picks up, across accounts: finished enrollments have no nextRunAt.
enrollmentSchema.index({ nextRunAt: 1 }, { sparse: true });
enrollmentSchema.index({ automationId: 1, status: 1 });
// A contact that unsubscribes or bounces leaves what it's in.
enrollmentSchema.index({ contactId: 1 });

export default mongoose.models.AutomationEnrollment || mongoose.model("AutomationEnrollment", enrollmentSchema);
