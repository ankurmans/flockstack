import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";
const schema = new mongoose.Schema({ newsletterId: { type: mongoose.Schema.Types.ObjectId, required: true }, campaignId: { type: mongoose.Schema.Types.ObjectId, required: true }, externalId: { type: String, required: true }, slot: { type: String, enum: Array.from({ length: 100 }, (_, index) => String(index + 1)) }, epoch: { type: String, required: true }, anchor: { type: mongoose.Schema.Types.Mixed }, authorId: { type: String }, authorName: { type: String, required: true }, body: { type: String, maxlength: 2000, required: true }, mentions: { type: [String], default: [] }, replies: { type: [mongoose.Schema.Types.Mixed], default: [] }, resolvedAt: Date, resolvedBy: String, removedAt: Date, revision: { type: Number, default: 0 } }, { timestamps: true });
schema.plugin(accountScoped);
schema.index({ accountId: 1, externalId: 1 }, { unique: true });
schema.index({ accountId: 1, campaignId: 1, slot: 1 }, { unique: true, partialFilterExpression: { slot: { $type: "string" } } });
schema.index({ accountId: 1, campaignId: 1, createdAt: -1, _id: -1 });
export default mongoose.models.EditorThread || mongoose.model("EditorThread", schema);
