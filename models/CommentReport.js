import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

// open: the owner hasn't decided. actioned: they hid or removed the comment. dismissed: they approved it.
export const REPORT_STATUSES = ["open", "actioned", "dismissed"];

// A subscriber's report of a comment, with a reason if they gave one (lib/comments.js). One report a reader per comment.
const commentReportSchema = new mongoose.Schema(
	{
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign", required: true },
		commentId: { type: mongoose.Schema.Types.ObjectId, ref: "Comment", required: true },
		reporterId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact", required: true },
		reason: { type: String },
		status: { type: String, enum: REPORT_STATUSES, default: "open" },
		resolvedAt: { type: Date },
		notifyPending: { type: Boolean },
	},
	{ timestamps: true }
);

commentReportSchema.plugin(accountScoped);
commentReportSchema.index({ commentId: 1, reporterId: 1 }, { unique: true });
commentReportSchema.index({ newsletterId: 1, status: 1, createdAt: -1, _id: -1 });
// Deleting a contact deletes the reports they made.
commentReportSchema.index({ reporterId: 1 });
commentReportSchema.index({ notifyPending: 1 }, { sparse: true });

export default mongoose.models.CommentReport || mongoose.model("CommentReport", commentReportSchema);
