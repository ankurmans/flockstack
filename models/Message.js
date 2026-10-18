import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

// held: a first send's never-mailed contacts past the first slice, queued once that slice checks out. skipped: a
// welcome email the month's emails had no room for (lib/sending.js), never sent later.
export const MESSAGE_STATUSES = [
	"held",
	"queued",
	"sent",
	"delivered",
	"bounced",
	"complained",
	"failed",
	"suppressed",
	"skipped",
];

const messageSchema = new mongoose.Schema(
	{
		// order: the email with a buyer's download link (lib/payments/orders.js). comment: a reader's sign-in link, a reply
		// or a moderation notice (lib/comment-notify.js).
		kind: { type: String, enum: ["campaign", "last-chance", "welcome", "confirmation", "referral", "test", "order", "automation", "comment"], required: true },
		campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign" },
		// An automation's email: the automation, the contact's enrollment in it and the step it is (lib/automations.js).
		automationId: { type: mongoose.Schema.Types.ObjectId, ref: "Automation" },
		enrollmentId: { type: mongoose.Schema.Types.ObjectId, ref: "AutomationEnrollment" },
		stepId: { type: String },
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		contactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact" },
		// A referral email: the reward it announces (Newsletter.referral.rewards[].id).
		referralRewardId: { type: String },
		email: { type: String, required: true, lowercase: true, trim: true },
		provider: { type: String },
		status: { type: String, enum: MESSAGE_STATUSES, default: "queued" },
		// The contact had never received an email from this account (lib/first-send.js).
		firstSend: { type: Boolean },
		// The email provider's id for it, when the send returns one; else the first event fills it in.
		providerMessageId: { type: String },
		error: { type: String },
		sentAt: Date,
		deliveredAt: Date,
		openedAt: Date,
		clickedAt: Date,
		bouncedAt: Date,
		complainedAt: Date,
	},
	{ timestamps: true }
);

messageSchema.plugin(accountScoped);
// One email per contact per campaign, even if a send job is retried.
messageSchema.index(
	{ campaignId: 1, contactId: 1 },
	{ unique: true, partialFilterExpression: { kind: "campaign" } }
);
// And at most one last-chance email per contact per send.
messageSchema.index(
	{ campaignId: 1, contactId: 1, kind: 1 },
	{ unique: true, partialFilterExpression: { kind: "last-chance" } }
);
// And one per enrollment and step, however often the job runs.
messageSchema.index({ enrollmentId: 1, stepId: 1 }, { unique: true, partialFilterExpression: { kind: "automation" } });
// An automation's report reads its emails.
messageSchema.index({ automationId: 1 }, { sparse: true });
messageSchema.index({ providerMessageId: 1 }, { sparse: true });
messageSchema.index({ kind: 1, createdAt: -1 });
// The overview's emails sent per hour.
messageSchema.index({ newsletterId: 1, sentAt: 1 });
messageSchema.index({ campaignId: 1, status: 1 });
// Emails still waiting to go out, which the plan check counts before a new send.
messageSchema.index({ accountId: 1, campaignId: 1 }, { partialFilterExpression: { status: "queued" } });
// The account-level check on the last days of sends (lib/account-health.js).
messageSchema.index({ accountId: 1, sentAt: -1 });

export default mongoose.models.Message || mongoose.model("Message", messageSchema);
