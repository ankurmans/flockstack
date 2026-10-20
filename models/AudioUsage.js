import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

// The characters an account's audio versions read in one calendar month (UTC), and the ones reserved for jobs still
// running (lib/audio-quota.js). month: "2026-10".
const audioUsageSchema = new mongoose.Schema(
	{
		month: { type: String, required: true },
		used: { type: Number, default: 0 },
		reserved: { type: Number, default: 0 },
	},
	{ timestamps: true }
);

audioUsageSchema.plugin(accountScoped);
audioUsageSchema.index({ accountId: 1, month: 1 }, { unique: true });

export default mongoose.models.AudioUsage || mongoose.model("AudioUsage", audioUsageSchema);
