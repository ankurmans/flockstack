import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

// pending: Checkout started, no card saved yet. active: the card is saved and nothing is charged. notifying and scheduled:
// a conversion is telling the reader (notifying) or told them (scheduled) the day of the first charge. charging, converted,
// failed (the card was refused, or the notice couldn't be emailed), canceled.
export const PLEDGE_STATUSES = ["pending", "active", "notifying", "scheduled", "charging", "converted", "failed", "canceled"];

// A reader's commitment to a price before the writer takes payments (lib/pledges.js). The card is saved on the creator's
// Stripe account with a SetupIntent and not charged: nothing is paid and no paid access is given until it is converted.
const pledgeSchema = new mongoose.Schema(
	{
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		contactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact" },
		email: { type: String, required: true, lowercase: true, trim: true },
		tierId: { type: String, required: true },
		// month or year, and the price at pledge time.
		option: { type: String, enum: ["month", "year"], required: true },
		amountCents: { type: Number, required: true },
		currency: { type: String, required: true },
		status: { type: String, enum: PLEDGE_STATUSES, default: "pending" },
		stripeCustomerId: { type: String },
		stripeSessionId: { type: String },
		setupIntentId: { type: String },
		paymentMethodId: { type: String },
		pledgedAt: { type: Date },
		// The email that says nothing was charged and links the cancel page went out.
		confirmationSentAt: { type: Date },
		// The conversion that is charging it, when the first charge was announced and when it takes place.
		conversionId: { type: mongoose.Schema.Types.ObjectId },
		noticeSentAt: { type: Date },
		chargeAt: { type: Date },
		chargingAt: { type: Date },
		subscriptionId: { type: String },
		convertedAt: { type: Date },
		canceledAt: { type: Date },
		failure: { type: String },
	},
	{ timestamps: true }
);

pledgeSchema.plugin(accountScoped);
pledgeSchema.index({ newsletterId: 1, status: 1, createdAt: 1 });
pledgeSchema.index({ newsletterId: 1, email: 1 });
pledgeSchema.index({ conversionId: 1, status: 1 }, { partialFilterExpression: { conversionId: { $exists: true } } });
pledgeSchema.index({ stripeSessionId: 1 }, { partialFilterExpression: { stripeSessionId: { $type: "string" } } });

export default mongoose.models.Pledge || mongoose.model("Pledge", pledgeSchema);
