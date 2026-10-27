import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";
const schema = new mongoose.Schema({
	newsletterId: { type: mongoose.Schema.Types.ObjectId, required: true },
	campaignId: mongoose.Schema.Types.ObjectId,
	contactId: mongoose.Schema.Types.ObjectId,
	messageId: mongoose.Schema.Types.ObjectId,
	externalId: { type: String, required: true },
	from: String,
	subject: String,
	text: String,
	archived: { type: Boolean, default: false },
}, { timestamps: true });
schema.plugin(accountScoped);
schema.index({ accountId: 1, externalId: 1 }, { unique: true });
schema.index({ accountId: 1, newsletterId: 1, createdAt: -1 });
export default mongoose.models.Reply || mongoose.model("Reply", schema);
