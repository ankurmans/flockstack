import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

// What the claim check found in a draft (lib/claim-check.js, docs/CLAIM-CHECK.md): dead links, figures not on the pages they
// link to, figures with no source. hash: the issue's words it was made for (campaignContentHash), so the same words are never checked
// twice in a day and any edit asks again. report: lib/claim-check-rules.js buildClaimReport, addresses and short excerpts of
// the issue only, never a page's text. Kept apart from the campaign, whose own changes mean "edited" to an approval.
const claimCheckSchema = new mongoose.Schema(
	{
		campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign", required: true },
		hash: { type: String, required: true },
		status: { type: String, enum: ["running", "done"], required: true },
		startedAt: { type: Date, required: true },
		checkedAt: { type: Date },
		report: { type: mongoose.Schema.Types.Mixed },
	},
	{ timestamps: true }
);

claimCheckSchema.plugin(accountScoped);
claimCheckSchema.index({ accountId: 1, campaignId: 1 }, { unique: true });
claimCheckSchema.index({ checkedAt: 1 });

export default mongoose.models.ClaimCheck || mongoose.model("ClaimCheck", claimCheckSchema);
