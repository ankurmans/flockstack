import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

// What one key or connected app did in one UTC day, counted as it happens: every call, so the API keys page can say how
// many today and the daily cap can stop a runaway one, never a row per call. day is YYYY-MM-DD. Kept 90 days.
const agentDaySchema = new mongoose.Schema(
	{
		actorId: { type: String, required: true },
		actorType: { type: String, enum: ["key", "app"], required: true },
		actorName: { type: String },
		day: { type: String, required: true },
		calls: { type: Number, default: 0 },
		changes: { type: Number, default: 0 },
		denied: { type: Number, default: 0 },
		// Contacts changed by calls that count toward SCALE_LIMITS (lib/action-scopes.js).
		scaled: { type: Number, default: 0 },
	},
	{ timestamps: true }
);

agentDaySchema.plugin(accountScoped);
agentDaySchema.index({ actorId: 1, day: 1 }, { unique: true });
agentDaySchema.index({ accountId: 1, day: -1 });

export default mongoose.models.AgentDay || mongoose.model("AgentDay", agentDaySchema);
