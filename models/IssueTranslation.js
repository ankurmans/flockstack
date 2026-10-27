import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";
const schema = new mongoose.Schema({
	newsletterId: { type: mongoose.Schema.Types.ObjectId, required: true },
	campaignId: { type: mongoose.Schema.Types.ObjectId, required: true },
	language: { type: String, required: true },
	sourceHash: { type: String, required: true },
	text: String,
	model: String,
	lease: String,
	leaseUntil: Date,
	expiresAt: { type: Date, required: true },
}, { timestamps: true });
schema.plugin(accountScoped);
schema.index({ accountId: 1, campaignId: 1, language: 1, sourceHash: 1 }, { unique: true });
schema.index({ expiresAt: 1 });
export default mongoose.models.IssueTranslation || mongoose.model("IssueTranslation", schema);
