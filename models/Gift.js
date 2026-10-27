import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

// awaiting_payment: Checkout started. paid: bought, waiting for its delivery date. sent: the recipient has the email and
// hasn't redeemed. redeemed. expired: not redeemed in time (lib/gift-rules.js). refunded: the payment was refunded in Stripe.
export const GIFT_STATUSES = ["awaiting_payment", "paid", "sent", "redeemed", "expired", "refunded"];

// A gift subscription (lib/gifts.js): someone pays once for months of a paid tier for a recipient, who gets an email on the date
// chosen with the buyer's message and a link to redeem it. Paid access starts when it is redeemed.
const giftSchema = new mongoose.Schema(
	{
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		tierId: { type: String, required: true },
		months: { type: Number, required: true },
		amountCents: { type: Number, required: true },
		currency: { type: String, required: true },
		buyerEmail: { type: String, required: true, lowercase: true, trim: true },
		buyerName: { type: String, trim: true },
		recipientEmail: { type: String, required: true, lowercase: true, trim: true },
		message: { type: String },
		// The day the recipient gets the email (UTC).
		deliverOn: { type: Date, required: true },
		status: { type: String, enum: GIFT_STATUSES, default: "awaiting_payment" },
		stripeSessionId: { type: String },
		paymentIntentId: { type: String },
		paidAt: { type: Date },
		expiresAt: { type: Date },
		receiptSentAt: { type: Date },
		deliveryClaimedAt: { type: Date },
		deliveryError: { type: String },
		sentAt: { type: Date },
		redeemedAt: { type: Date },
		contactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact" },
		accessUntil: { type: Date },
		referralRewardId: { type: mongoose.Schema.Types.ObjectId, ref: "ReferralReward" },
	},
	{ timestamps: true }
);

giftSchema.plugin(accountScoped);
giftSchema.index({ newsletterId: 1, status: 1, createdAt: -1 });
giftSchema.index({ newsletterId: 1, buyerEmail: 1 });
giftSchema.index({ status: 1, deliverOn: 1 });
giftSchema.index({ status: 1, expiresAt: 1 });
giftSchema.index({ paymentIntentId: 1 }, { partialFilterExpression: { paymentIntentId: { $type: "string" } } });

giftSchema.index({ accountId: 1, referralRewardId: 1 }, { unique: true, partialFilterExpression: { referralRewardId: { $exists: true } } });

export default mongoose.models.Gift || mongoose.model("Gift", giftSchema);
