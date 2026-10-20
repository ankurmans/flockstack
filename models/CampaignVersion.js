import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

// An earlier state of a draft (lib/campaign-versions.js): what it held just before an edit changed it, kept so the writer
// can go back. The last few per campaign stay; older ones are deleted as new ones are made.
const campaignVersionSchema = new mongoose.Schema(
	{
		campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign", required: true },
		subject: { type: String, default: "" },
		previewText: { type: String, default: "" },
		format: { type: String, enum: ["markdown", "html", "rich"], default: "rich" },
		markdown: { type: String, default: "" },
		html: { type: String, default: "" },
		// autosave: the state before an edit. restore: the state a restore replaced.
		reason: { type: String, enum: ["autosave", "restore"], default: "autosave" },
	},
	{ timestamps: true }
);

campaignVersionSchema.plugin(accountScoped);
campaignVersionSchema.index({ campaignId: 1, createdAt: -1 });

export default mongoose.models.CampaignVersion || mongoose.model("CampaignVersion", campaignVersionSchema);
