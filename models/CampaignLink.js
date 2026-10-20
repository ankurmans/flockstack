import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

// One tracked link of a sent campaign, by its place in the email (lib/tracking.js), written when the send starts.
// Clicks are counted here, never as a row per click: clicks every time a person follows it, uniqueClicks once per
// recipient (Message.clickedLinks).
const campaignLinkSchema = new mongoose.Schema(
	{
		campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign", required: true },
		index: { type: Number, required: true, min: 0 },
		url: { type: String, required: true },
		clicks: { type: Number, default: 0 },
		uniqueClicks: { type: Number, default: 0 },
	},
	{ timestamps: true }
);

campaignLinkSchema.plugin(accountScoped);
campaignLinkSchema.index({ campaignId: 1, index: 1 }, { unique: true });

export default mongoose.models.CampaignLink || mongoose.model("CampaignLink", campaignLinkSchema);
