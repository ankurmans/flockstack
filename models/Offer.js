import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

export const OFFER_TYPES = ["percent", "amount", "trial"];
export const OFFER_DURATIONS = ["once", "repeating", "forever"];

// A discount or a free trial for a paid tier (lib/offers.js). A discount is a coupon made on the creator's Stripe account;
// the offer's link (/offer/<code> on the newsletter's site) shows the discounted price and opens Checkout with the coupon on.
// A trial-only offer has no coupon: it gives its link a trial of its own length.
const offerSchema = new mongoose.Schema(
	{
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		name: { type: String, required: true, trim: true },
		// In the link: lowercase letters, digits and dashes, unique in the newsletter.
		code: { type: String, required: true, lowercase: true, trim: true },
		type: { type: String, enum: OFFER_TYPES, required: true },
		percentOff: { type: Number },
		amountOffCents: { type: Number },
		currency: { type: String, lowercase: true },
		duration: { type: String, enum: OFFER_DURATIONS },
		durationMonths: { type: Number },
		maxRedemptions: { type: Number },
		expiresAt: { type: Date },
		// Only these tiers, or every tier when empty.
		tierIds: { type: [String], default: undefined },
		trialDays: { type: Number },
		trialNoCard: { type: Boolean },
		active: { type: Boolean, default: true },
		stripeCouponId: { type: String },
	},
	{ timestamps: true }
);

offerSchema.plugin(accountScoped);
offerSchema.index({ newsletterId: 1, code: 1 }, { unique: true });
offerSchema.index({ accountId: 1, newsletterId: 1, createdAt: -1 });

export default mongoose.models.Offer || mongoose.model("Offer", offerSchema);
