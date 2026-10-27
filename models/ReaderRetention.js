import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

const schema = new mongoose.Schema({
	newsletterId: { type: mongoose.Schema.Types.ObjectId, required: true },
	contactId: { type: mongoose.Schema.Types.ObjectId },
	subscriptionId: { type: String, required: true },
	chargeAccount: { type: String, required: true },
	revision: { type: Number, default: 0 },
	lease: { type: String },
	pending: { kind: { type: String, enum: ["pause", "unpause", "resume", "save", "cancel"] }, externalId: { type: String }, startedAt: { type: Date }, months: { type: Number }, couponId: { type: String }, offerId: { type: mongoose.Schema.Types.ObjectId }, scheduleId: { type: String }, requestHash: { type: String }, request: { type: mongoose.Schema.Types.Mixed }, params: { type: mongoose.Schema.Types.Mixed } },
	lastExternalId: { type: String },
	lastKind: { type: String },
	lastRequestHash: { type: String },
	stripeScheduleId: { type: String },
	scheduleTermsHash: { type: String },
	pauseKey: { type: String },
	pauseMonths: { type: Number },
	pauseAt: { type: Date },
	resumeAt: { type: Date },
	pauseState: { type: String, enum: ["scheduled", "paused", "resume_pending", "ended"] },
	saveCouponId: { type: String },
	saveOfferId: { type: mongoose.Schema.Types.ObjectId },
	saveUsedAt: { type: Date },
	observedAt: { type: Date },
	observedSubscriptionStatus: { type: String },
	cancellationRequestedAt: { type: Date },
}, { timestamps: true });
schema.plugin(accountScoped);
schema.index({ accountId: 1, subscriptionId: 1 }, { unique: true });
schema.index({ accountId: 1, contactId: 1 });
schema.index({ accountId: 1, newsletterId: 1, updatedAt: -1, _id: -1 });
schema.index({ accountId: 1, stripeScheduleId: 1 }, { partialFilterExpression: { stripeScheduleId: { $type: "string" } } });
export default mongoose.models.ReaderRetention || mongoose.model("ReaderRetention", schema);
