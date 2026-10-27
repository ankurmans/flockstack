import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

// A link that opens one paid issue's web page for whoever holds it (lib/gift-links.js), without a subscription. A paid reader
// makes it from the issue (createdBy reader, contactId theirs) or the owner does (createdBy owner). code is the secret in the
// link. opens counts the browsers that opened it, up to maxOpens, until expiresAt; revokedAt ends it at once.
const giftLinkSchema = new mongoose.Schema(
	{
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign", required: true },
		code: { type: String, required: true },
		createdBy: { type: String, enum: ["owner", "reader"], required: true },
		contactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact" },
		note: { type: String, trim: true },
		maxOpens: { type: Number, required: true },
		opens: { type: Number, default: 0 },
		lastOpenedAt: { type: Date },
		expiresAt: { type: Date, required: true },
		revokedAt: { type: Date },
	},
	{ timestamps: true }
);

giftLinkSchema.plugin(accountScoped);
giftLinkSchema.index({ code: 1 }, { unique: true });
giftLinkSchema.index({ newsletterId: 1, createdAt: -1 });
giftLinkSchema.index({ newsletterId: 1, campaignId: 1, createdAt: -1 });
giftLinkSchema.index({ newsletterId: 1, contactId: 1, createdAt: -1 });

export default mongoose.models.GiftLink || mongoose.model("GiftLink", giftLinkSchema);
