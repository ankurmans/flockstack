import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

const schema = new mongoose.Schema({
	newsletterId: { type: mongoose.Schema.Types.ObjectId, required: true },
	otherNewsletterId: { type: mongoose.Schema.Types.ObjectId, required: true },
	otherName: { type: String, required: true },
	closed: { type: Boolean, default: false },
	lastMessageAt: { type: Date },
}, { timestamps: true });
schema.plugin(accountScoped);
schema.index({ accountId: 1, newsletterId: 1, otherNewsletterId: 1 }, { unique: true });
schema.index({ accountId: 1, newsletterId: 1, lastMessageAt: -1, _id: -1 });
export default mongoose.models.CreatorConversation || mongoose.model("CreatorConversation", schema);
