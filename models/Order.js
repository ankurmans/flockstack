import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

// paid: the buyer can download. refunded: refunded in full in Stripe, the download link stops working. disputed: the
// buyer's bank pulled the payment back (a chargeback), the link stops working too.
export const ORDER_STATUSES = ["paid", "refunded", "disputed"];
// The email with the download link. suppressed: the address bounced or complained before, so nothing was sent.
export const ORDER_EMAIL_STATUSES = ["pending", "sent", "suppressed", "failed"];

const orderSchema = new mongoose.Schema(
	{
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
		// What the buyer bought as it was then: the product can change or go away afterwards.
		productTitle: { type: String, required: true },
		stripeSessionId: { type: String, required: true },
		stripePaymentIntentId: { type: String },
		buyerEmail: { type: String, required: true, lowercase: true, trim: true },
		buyerName: { type: String, trim: true },
		amountCents: { type: Number, required: true },
		currency: { type: String, required: true, lowercase: true },
		amountRefundedCents: { type: Number, default: 0 },
		status: { type: String, enum: ORDER_STATUSES, default: "paid" },
		paidAt: { type: Date },
		refundedAt: { type: Date },
		// A refund or a chargeback stops the download link; so does the seller resending it, which replaces the old one.
		revokedAt: { type: Date },
		tokenVersion: { type: Number, default: 1 },
		downloadCount: { type: Number, default: 0 },
		lastDownloadAt: { type: Date },
		emailStatus: { type: String, enum: ORDER_EMAIL_STATUSES, default: "pending" },
		emailSentAt: { type: Date },
		emailClaimedAt: { type: Date },
		emailError: { type: String },
		// The buyer ticked "add me to the newsletter" at checkout; the contact follows the newsletter's own opt-in rules.
		listConsent: {
			at: { type: Date },
			contactId: { type: mongoose.Schema.Types.ObjectId },
		},
	},
	{ timestamps: true }
);

orderSchema.plugin(accountScoped);
// A Checkout Session pays once: a repeated webhook finds its order instead of making another.
orderSchema.index({ stripeSessionId: 1 }, { unique: true });
orderSchema.index({ stripePaymentIntentId: 1 }, { partialFilterExpression: { stripePaymentIntentId: { $type: "string" } } });
orderSchema.index({ accountId: 1, createdAt: -1, _id: -1 });
orderSchema.index({ productId: 1, createdAt: -1 });
orderSchema.index({ accountId: 1, buyerEmail: 1 });

export default mongoose.models.Order || mongoose.model("Order", orderSchema);
