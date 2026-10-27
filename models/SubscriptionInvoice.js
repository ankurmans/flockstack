import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

const schema = new mongoose.Schema({
	newsletterId: { type: mongoose.Schema.Types.ObjectId, required: true },
	subscriptionId: { type: String, required: true },
	invoiceId: { type: String, required: true },
	currency: { type: String, required: true },
	amountPaidMinor: { type: Number, required: true },
	totalExTaxMinor: { type: Number },
	postPaymentCreditsMinor: { type: Number },
	paidOutOfBand: { type: Boolean },
	paidAt: { type: Date, required: true },
	observedAt: { type: Date, required: true },
	sourceAt: { type: Date, required: true },
	revision: { type: Number, default: 1 },
	source: { type: String, enum: ["webhook", "refresh"], required: true },
	providerEventId: { type: String },
}, { timestamps: true });
schema.plugin(accountScoped);
schema.index({ accountId: 1, invoiceId: 1 }, { unique: true });
schema.index({ accountId: 1, newsletterId: 1, paidAt: 1, _id: 1 });
export default mongoose.models.SubscriptionInvoice || mongoose.model("SubscriptionInvoice", schema);
