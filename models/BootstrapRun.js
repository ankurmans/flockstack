import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";
const schema = new mongoose.Schema({
	externalId: { type: String, required: true },
	fingerprint: { type: String, required: true },
	steps: { type: mongoose.Schema.Types.Mixed },
	lease: String,
	leaseUntil: Date,
	completedAt: Date,
}, { timestamps: true });
schema.plugin(accountScoped);
schema.index({ accountId: 1, externalId: 1 }, { unique: true });
export default mongoose.models.BootstrapRun || mongoose.model("BootstrapRun", schema);
