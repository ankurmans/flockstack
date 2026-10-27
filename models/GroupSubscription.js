import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

const schema = new mongoose.Schema({
	newsletterId: { type: mongoose.Schema.Types.ObjectId, required: true },
	tierId: { type: String, required: true },
	option: { type: String, enum: ["month", "quarter", "year"], required: true },
	buyerEmail: { type: String, trim: true, lowercase: true, required: true },
	requestedSeats: { type: Number, min: 2, max: 100, required: true },
	capacity: { type: Number, min: 0, max: 100, default: 0 },
	status: { type: String, enum: ["checkout", "active", "canceled"], default: "checkout" },
	subscriptionStatus: { type: String },
	priceId: { type: String },
	currency: { type: String },
	unitAmountCents: { type: Number },
	checkoutStartedAt: { type: Date },
	portalConfigurationId: { type: String },
	chargeAccount: { type: String, required: true },
	stripeSessionId: { type: String },
	stripeCustomerId: { type: String },
	stripeSubscriptionId: { type: String },
	paidUntil: { type: Date },
	providerPeriodEnd: { type: Date },
	verifiedInvoiceId: { type: String },
	billingLease: { type: String },
	billingObservedAt: { type: Date },
	billingProblem: { type: String },
	managerVersion: { type: Number, default: 0 },
	buyerReceiptSentAt: { type: Date },
	buyerVerifiedAt: { type: Date },
	revision: { type: Number, default: 0 },
	externalId: { type: String },
	seats: [{
		id: { type: String },
		email: { type: String, trim: true, lowercase: true },
		status: { type: String, enum: ["invited", "accepting", "active", "revoked"] },
		contactId: { type: mongoose.Schema.Types.ObjectId },
		invitedAt: { type: Date },
		consentedAt: { type: Date },
		acceptedAt: { type: Date },
		invitationVersion: { type: Number, default: 0 },
		invitationSentAt: { type: Date },
	}],
}, { timestamps: true });
schema.plugin(accountScoped);
schema.index({ accountId: 1, externalId: 1 }, { unique: true, partialFilterExpression: { externalId: { $type: "string" } } });
schema.index({ accountId: 1, stripeSubscriptionId: 1 }, { unique: true, partialFilterExpression: { stripeSubscriptionId: { $type: "string" } } });
schema.index({ stripeSubscriptionId: 1 }, { partialFilterExpression: { stripeSubscriptionId: { $type: "string" } } });
schema.index({ accountId: 1, newsletterId: 1, createdAt: -1, _id: -1 });
export default mongoose.models.GroupSubscription || mongoose.model("GroupSubscription", schema);
