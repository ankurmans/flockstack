import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

// Each participant owns a copy. Creating both copies is one transactional docdb insert.
const schema = new mongoose.Schema({
	newsletterId: { type: mongoose.Schema.Types.ObjectId, required: true },
	conversationId: { type: mongoose.Schema.Types.ObjectId, required: true },
	messageKey: { type: String, required: true },
	fromNewsletterId: { type: mongoose.Schema.Types.ObjectId, required: true },
	toNewsletterId: { type: mongoose.Schema.Types.ObjectId, required: true },
	fromName: { type: String, required: true },
	body: { type: String, required: true },
	direction: { type: String, enum: ["incoming", "outgoing"], required: true },
	notificationAttemptedAt: { type: Date },
	webhookAttemptedAt: { type: Date },
}, { timestamps: true });
schema.plugin(accountScoped);
schema.index({ accountId: 1, newsletterId: 1, messageKey: 1 }, { unique: true });
schema.index({ accountId: 1, conversationId: 1, _id: -1 });
export default mongoose.models.CreatorMessage || mongoose.model("CreatorMessage", schema);
