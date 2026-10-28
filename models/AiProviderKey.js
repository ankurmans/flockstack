import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";
import { AI_KEY_STATUSES, AI_PROVIDERS } from "../lib/briefing-rules.js";

// An account's own key for an AI provider, used by its briefings (docs/BRIEFINGS-DESIGN.md). secret is the key encrypted with
// lib/credentials.js (context ai-key:<accountId>:<keyId>), hidden from every read unless asked for with +secret, and only the
// briefings engine asks. hint is its last four characters, so the dashboard can tell keys apart without showing one.
const aiProviderKeySchema = new mongoose.Schema(
	{
		name: { type: String, required: true, trim: true },
		provider: { type: String, enum: AI_PROVIDERS, required: true },
		// openai-compatible only: the server's https address.
		baseUrl: { type: String, trim: true },
		// cloudflare only: the user's own Cloudflare account ID, part of the Workers AI address.
		accountRef: { type: String, trim: true },
		secret: { type: String, required: true, select: false },
		hint: { type: String, required: true },
		status: { type: String, enum: AI_KEY_STATUSES, default: "unchecked" },
		checkedAt: { type: Date },
		lastUsedAt: { type: Date },
		createdBy: { type: String },
	},
	{ timestamps: true }
);

aiProviderKeySchema.plugin(accountScoped);
aiProviderKeySchema.index({ createdAt: 1 });

export default mongoose.models.AiProviderKey || mongoose.model("AiProviderKey", aiProviderKeySchema);
