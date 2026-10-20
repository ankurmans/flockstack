import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

// A saved issue to start new ones from (lib/templates.js): the subject, the preview text and the content in the format the
// issue had.
const issueTemplateSchema = new mongoose.Schema(
	{
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		name: { type: String, required: true, trim: true },
		subject: { type: String, trim: true, default: "" },
		previewText: { type: String, trim: true, default: "" },
		format: { type: String, enum: ["markdown", "html", "rich"], default: "rich" },
		markdown: { type: String, default: "" },
		html: { type: String, default: "" },
	},
	{ timestamps: true }
);

issueTemplateSchema.plugin(accountScoped);
issueTemplateSchema.index({ newsletterId: 1, name: 1 });

export default mongoose.models.IssueTemplate || mongoose.model("IssueTemplate", issueTemplateSchema);
