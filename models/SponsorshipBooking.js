import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

const schema = new mongoose.Schema({
	newsletterId: { type: mongoose.Schema.Types.ObjectId, required: true },
	slotId: { type: mongoose.Schema.Types.ObjectId, required: true },
	placementId: { type: mongoose.Schema.Types.ObjectId, required: true },
	placementName: { type: String, required: true },
	day: { type: String, required: true },
	timeZone: { type: String, required: true },
	amountMinor: { type: Number, required: true },
	currency: { type: String, required: true },
	email: { type: String, required: true, trim: true, lowercase: true },
	brandName: { type: String, required: true, trim: true, maxlength: 120 },
	status: { type: String, enum: ["unverified", "requested", "accepted", "invoiced", "paid", "canceled"], default: "unverified" },
	verifiedAt: { type: Date },
	verificationVersion: { type: Number, default: 0 },
	managerVersion: { type: Number, default: 0 },
	requestEmailSentAt: { type: Date },
	acceptedAt: { type: Date },
	canceledAt: { type: Date },
	cancelingAt: { type: Date },
	creative: {
		headline: { type: String, maxlength: 120 }, body: { type: String, maxlength: 2000 },
		callToAction: { type: String, maxlength: 60 }, url: { type: String, maxlength: 2000 },
		assetId: { type: mongoose.Schema.Types.ObjectId },
	},
	creativeHash: { type: String },
	assetUploads: [{ type: String }],
	approvedCreativeHash: { type: String },
	approvedAt: { type: Date },
	approvedBy: { type: String },
	chargeAccount: { type: String },
	stripeCustomerId: { type: String },
	stripeInvoiceId: { type: String },
	stripeInvoiceItemId: { type: String },
	invoiceStartedAt: { type: Date },
	invoiceLease: { type: String },
	invoiceFunded: { type: Boolean, default: false },
	invoiceObservedAt: { type: Date },
	invoiceProblem: { type: String },
	invoice: {
		id: { type: String }, status: { type: String }, currency: { type: String },
		totalMinor: { type: Number }, amountPaidMinor: { type: Number }, amountDueMinor: { type: Number },
		paidAt: { type: Date }, hostedUrl: { type: String }, pdfUrl: { type: String },
	},
	invoiceEmailSentAt: { type: Date },
	campaignId: { type: mongoose.Schema.Types.ObjectId },
	externalId: { type: String, required: true },
	revision: { type: Number, default: 0 },
}, { timestamps: true });
schema.plugin(accountScoped);
schema.index({ accountId: 1, externalId: 1 }, { unique: true });
schema.index({ accountId: 1, stripeInvoiceId: 1 }, { unique: true, partialFilterExpression: { stripeInvoiceId: { $type: "string" } } });
schema.index({ stripeInvoiceId: 1 }, { partialFilterExpression: { stripeInvoiceId: { $type: "string" } } });
schema.index({ accountId: 1, newsletterId: 1, status: 1, createdAt: -1, _id: -1 });
schema.index({ accountId: 1, slotId: 1, status: 1 });
export default mongoose.models.SponsorshipBooking || mongoose.model("SponsorshipBooking", schema);
