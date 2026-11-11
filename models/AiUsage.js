import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

// How many writing-tool requests (lib/ai-usage.js) an account made on one UTC day: a counter, and the text AI's per-model tally, never the text. Rows older
// than a couple of weeks are deleted as the account's next day starts.
const aiUsageSchema = new mongoose.Schema(
	{
		day: { type: String, required: true },
		count: { type: Number, default: 0, min: 0 },
		// The text AI's calls today by provider, model and feature, as counts and token numbers: lib/ai-usage.js recordAiCall.
		spend: { type: mongoose.Schema.Types.Mixed },
	},
	{ timestamps: true }
);

aiUsageSchema.plugin(accountScoped);
aiUsageSchema.index({ accountId: 1, day: 1 }, { unique: true });

export default mongoose.models.AiUsage || mongoose.model("AiUsage", aiUsageSchema);
