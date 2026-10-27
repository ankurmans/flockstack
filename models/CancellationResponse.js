import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";
const schema = new mongoose.Schema({
	newsletterId: { type: mongoose.Schema.Types.ObjectId, required: true },
	contactId: { type: mongoose.Schema.Types.ObjectId },
	retentionId: { type: mongoose.Schema.Types.ObjectId, required: true },
	externalId: { type: String, required: true },
	reason: { type: String, enum: ["cost", "not_reading", "content", "temporary", "other"] },
	comment: { type: String, maxlength: 1000 },
	sharedAt: { type: Date, required: true },
	cancellationConfirmedAt: { type: Date },
}, { timestamps: true });
schema.plugin(accountScoped);
schema.index({ accountId: 1, retentionId: 1, externalId: 1 }, { unique: true });
schema.index({ accountId: 1, newsletterId: 1, createdAt: -1, _id: -1 });
schema.index({ accountId: 1, contactId: 1 });
export default mongoose.models.CancellationResponse || mongoose.model("CancellationResponse", schema);
