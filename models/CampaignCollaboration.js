import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";
const schema = new mongoose.Schema({ newsletterId: { type: mongoose.Schema.Types.ObjectId, required: true }, campaignId: { type: mongoose.Schema.Types.ObjectId, required: true }, epoch: { type: String, required: true }, fingerprint: { type: String, required: true }, state: { type: String, required: true }, checkpointAt: { type: Date, required: true } }, { timestamps: true });
schema.plugin(accountScoped);
schema.index({ accountId: 1, campaignId: 1 }, { unique: true });
schema.index({ checkpointAt: 1 });
export default mongoose.models.CampaignCollaboration || mongoose.model("CampaignCollaboration", schema);
