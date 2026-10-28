import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

// How much of a search key's published limits an account has used in a window, so its briefings share them and stay under.
// keyId is absent for the free indexes, which are paced per account. Kept USAGE_RETENTION_DAYS (lib/briefing-rules.js).
const discoveryUsageSchema = new mongoose.Schema(
	{
		provider: { type: String, required: true },
		keyId: { type: String, default: "" },
		operation: { type: String, enum: ["search", "fetch"], required: true },
		window: { type: String, enum: ["minute", "hour", "day"], required: true },
		windowStart: { type: Date, required: true },
		count: { type: Number, default: 0 },
		// Set when the provider said the window is used up, to stop asking before it resets.
		exhaustedUntil: { type: Date },
	},
	{ timestamps: false }
);

discoveryUsageSchema.plugin(accountScoped);
discoveryUsageSchema.index({ provider: 1, keyId: 1, operation: 1, window: 1, windowStart: 1 }, { unique: true });
discoveryUsageSchema.index({ windowStart: 1 });

export default mongoose.models.DiscoveryUsage || mongoose.model("DiscoveryUsage", discoveryUsageSchema);
