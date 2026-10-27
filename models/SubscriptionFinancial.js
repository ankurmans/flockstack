import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

const schema = new mongoose.Schema({
	newsletterId: { type: mongoose.Schema.Types.ObjectId, required: true },
	subscriptionId: { type: String, required: true },
	state: { type: mongoose.Schema.Types.Mixed, required: true },
	revision: { type: Number, default: 1 },
	firstObservedAt: { type: Date, required: true },
	observedAt: { type: Date, required: true },
	source: { type: String, enum: ["webhook", "refresh", "import"], required: true },
	pendingChanges: { type: [mongoose.Schema.Types.Mixed], default: [] },
}, { timestamps: true });
schema.plugin(accountScoped);
schema.index({ accountId: 1, subscriptionId: 1 }, { unique: true });
schema.index({ accountId: 1, newsletterId: 1, _id: 1 });
export default mongoose.models.SubscriptionFinancial || mongoose.model("SubscriptionFinancial", schema);
