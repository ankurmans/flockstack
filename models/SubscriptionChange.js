import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

const schema = new mongoose.Schema({
	newsletterId: { type: mongoose.Schema.Types.ObjectId, required: true },
	subscriptionId: { type: String, required: true },
	eventKey: { type: String, required: true },
	before: { type: mongoose.Schema.Types.Mixed },
	after: { type: mongoose.Schema.Types.Mixed, required: true },
	at: { type: Date, required: true },
	source: { type: String, enum: ["webhook", "refresh", "import"], required: true },
	providerEventId: { type: String },
}, { timestamps: true });
schema.plugin(accountScoped);
schema.index({ accountId: 1, eventKey: 1 }, { unique: true });
schema.index({ accountId: 1, newsletterId: 1, at: 1, _id: 1 });
export default mongoose.models.SubscriptionChange || mongoose.model("SubscriptionChange", schema);
