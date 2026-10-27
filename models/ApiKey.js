import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

export const API_KEY_LEVELS = ["read_only", "drafts", "send_with_approval", "full", "signups"];

const apiKeySchema = new mongoose.Schema(
	{
		name: { type: String, required: true, trim: true },
		purpose: { type: String, enum: ["assistant"] },
		prefix: { type: String, required: true },
		// The key itself is the lookup: unique across accounts, and it decides the account.
		hash: { type: String, required: true, unique: true },
		// What the key may do (lib/action-scopes.js): full is every customer action, signups only adding contacts for keys in
		// website code. Keys made before levels existed have none and count as signups (lib/api-key-tokens.js getKeyLevel).
		level: { type: String, enum: API_KEY_LEVELS },
		// A key limited to one newsletter reaches nothing of the account's others.
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter" },
		// Calls a day (UTC), counted in AgentDay; none means no cap.
		dailyCap: { type: Number },
		// After this the key answers unauthorized, like a revoked one.
		expiresAt: { type: Date },
		lastUsedAt: { type: Date },
		revokedAt: { type: Date },
	},
	{ timestamps: true }
);

apiKeySchema.plugin(accountScoped);
apiKeySchema.index({ accountId: 1, createdAt: -1 });

export default mongoose.models.ApiKey || mongoose.model("ApiKey", apiKeySchema);
