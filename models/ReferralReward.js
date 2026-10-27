import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

// A reward a subscriber unlocked, once: the record is what keeps its email from going out twice, even when two referrals
// are credited at the same time.
const referralRewardSchema = new mongoose.Schema(
	{
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		contactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact", required: true },
		rewardId: { type: String, required: true },
		referrals: { type: Number, required: true },
		benefit: { type: mongoose.Schema.Types.Mixed },
		state: { type: String, enum: ["pending", "ready"], default: "pending" },
		codeId: { type: mongoose.Schema.Types.ObjectId, ref: "ReferralCode" },
		giftId: { type: mongoose.Schema.Types.ObjectId, ref: "Gift" },
		fulfilledAt: { type: Date },
	},
	{ timestamps: true }
);

referralRewardSchema.plugin(accountScoped);
referralRewardSchema.index({ contactId: 1, rewardId: 1 }, { unique: true });
referralRewardSchema.index({ newsletterId: 1, createdAt: -1 });

export default mongoose.models.ReferralReward || mongoose.model("ReferralReward", referralRewardSchema);
