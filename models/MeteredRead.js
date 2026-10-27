import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";
const schema = new mongoose.Schema({
	newsletterId: { type: mongoose.Schema.Types.ObjectId, required: true },
	contactId: { type: mongoose.Schema.Types.ObjectId, required: true },
	period: { type: String, required: true },
	count: { type: Number, default: 0 },
	issueIds: { type: [String], default: [] },
	expiresAt: { type: Date, required: true },
}, { timestamps: true });
schema.plugin(accountScoped);
schema.index({ accountId: 1, newsletterId: 1, contactId: 1, period: 1 }, { unique: true });
schema.index({ expiresAt: 1 });
export default mongoose.models.MeteredRead || mongoose.model("MeteredRead", schema);
