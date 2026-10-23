import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

// What the ready-to-send check found when it opened the links of a draft (lib/link-check.js), kept for the draft so the
// review step shows it again without asking the sites again. hash: the list of addresses it was made for, so editing a link
// asks again and editing anything else doesn't. Kept apart from the campaign, whose own changes mean "edited" to an approval.
const linkCheckSchema = new mongoose.Schema(
	{
		campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign", required: true },
		hash: { type: String, required: true },
		status: { type: String, enum: ["running", "done"], required: true },
		total: { type: Number, default: 0 },
		startedAt: { type: Date, required: true },
		checkedAt: { type: Date },
		results: { type: [mongoose.Schema.Types.Mixed], default: [] },
	},
	{ timestamps: true }
);

linkCheckSchema.plugin(accountScoped);
linkCheckSchema.index({ accountId: 1, campaignId: 1 }, { unique: true });
linkCheckSchema.index({ checkedAt: 1 });

export default mongoose.models.LinkCheck || mongoose.model("LinkCheck", linkCheckSchema);
