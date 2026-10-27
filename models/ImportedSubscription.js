import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";
const schema = new mongoose.Schema({
	newsletterId: { type: mongoose.Schema.Types.ObjectId, required: true },
	stripeSubscriptionId: { type: String, required: true },
	chargeAccount: { type: String, required: true },
	priceId: String,
	tierId: String,
	contactId: mongoose.Schema.Types.ObjectId,
}, { timestamps: true });
schema.plugin(accountScoped);
schema.index({ accountId: 1, stripeSubscriptionId: 1 }, { unique: true });
export default mongoose.models.ImportedSubscription || mongoose.model("ImportedSubscription", schema);
