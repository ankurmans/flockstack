import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

// Assignment stays with the receipt after a contact is deleted: a redeemed code must never enter stock again.
const schema = new mongoose.Schema({
	newsletterId: { type: mongoose.Schema.Types.ObjectId, required: true },
	rewardId: { type: String, required: true },
	code: { type: String, required: true },
	codeHash: { type: String, required: true },
	receiptId: { type: mongoose.Schema.Types.ObjectId, ref: "ReferralReward" },
	assignedAt: { type: Date },
}, { timestamps: true });
schema.plugin(accountScoped);
schema.index({ accountId: 1, newsletterId: 1, codeHash: 1 }, { unique: true });
schema.index({ accountId: 1, receiptId: 1 }, { unique: true, partialFilterExpression: { receiptId: { $exists: true } } });
schema.index({ newsletterId: 1, rewardId: 1, assignedAt: 1, _id: 1 });
export default mongoose.models.ReferralCode || mongoose.model("ReferralCode", schema);
