import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

// pending: signed up through a referral link and hasn't confirmed. credited: counted for the referrer. rejected: never
// counted, with the reason (lib/referrals.js REJECTION_REASONS).
export const REFERRAL_STATUSES = ["pending", "credited", "rejected"];

const referralSchema = new mongoose.Schema(
	{
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		referrerId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact", required: true },
		referredId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact", required: true },
		status: { type: String, enum: REFERRAL_STATUSES, default: "pending" },
		reason: { type: String },
		// A keyed hash of the address they signed up from: never the address itself.
		ipHash: { type: String },
		creditedAt: { type: Date },
	},
	{ timestamps: true }
);

referralSchema.plugin(accountScoped);
// A person is referred once, by one referrer.
referralSchema.index({ referredId: 1 }, { unique: true });
referralSchema.index({ referrerId: 1, status: 1 });
referralSchema.index({ newsletterId: 1, status: 1, createdAt: -1 });
referralSchema.index({ newsletterId: 1, createdAt: -1, _id: -1 });

export default mongoose.models.Referral || mongoose.model("Referral", referralSchema);
