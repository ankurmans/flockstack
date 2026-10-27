import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";
import { COMMENT_STATUSES } from "../lib/comment-rules.js";

// A reader's comment on a web issue (lib/comments.js). One level of replies: a reply's parentId is a comment without one.
// authorId is the subscriber's contact; it is gone, and authorName is "Deleted reader", once the contact is deleted
// (lib/comments.js anonymizeComments). Nothing here is the reader's email: the owner finds it through the contact.
// reason: why it is held, hidden or removed, shown to its author and to the owner. decidedBy: rules (the newsletter's
// moderation setting), creator or author. reports: open reports. notifyPending: not yet in the owner's digest.
const commentSchema = new mongoose.Schema(
	{
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign", required: true },
		parentId: { type: mongoose.Schema.Types.ObjectId, ref: "Comment" },
		authorId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact" },
		authorName: { type: String, required: true },
		body: { type: String, default: "" },
		status: { type: String, enum: COMMENT_STATUSES, default: "published" },
		reason: { type: String },
		decidedBy: { type: String, enum: ["rules", "creator", "author"] },
		decidedAt: { type: Date },
		edited: { type: Boolean },
		editedAt: { type: Date },
		reports: { type: Number },
		bodyHash: { type: String },
		ipHash: { type: String },
		notifyPending: { type: Boolean },
		replyNotifiedAt: { type: Date },
		replyRuleConsentAt: { type: Date },
		replyRuleConsentHash: { type: String },
		replyRuleExampleConsent: { type: Boolean },
		replyRuleDecision: {
			outcome: { type: String }, model: { type: String }, revision: { type: String }, evaluatedAt: { type: Date },
			confidence: { type: Number }, ruleId: { type: String }, exampleCount: { type: Number },
		},
	},
	{ timestamps: true }
);

commentSchema.plugin(accountScoped);
// An issue's page reads its published comments in the order they were written.
commentSchema.index({ campaignId: 1, status: 1, createdAt: 1 });
// The dashboard's list, newest first, with and without a status.
commentSchema.index({ newsletterId: 1, createdAt: -1, _id: -1 });
commentSchema.index({ newsletterId: 1, status: 1, createdAt: -1, _id: -1 });
// A reader's own comments on an issue, and the duplicate check.
commentSchema.index({ campaignId: 1, authorId: 1 });
// Anonymizing a deleted contact's comments.
commentSchema.index({ authorId: 1 }, { sparse: true });
commentSchema.index({ parentId: 1 }, { sparse: true });
commentSchema.index({ notifyPending: 1 }, { sparse: true });

export default mongoose.models.Comment || mongoose.model("Comment", commentSchema);
