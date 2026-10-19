import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

// An address the account's events are POSTed to (lib/webhooks.js). events: the types it takes, every type when empty.
// newsletterId: only that newsletter's events; account-wide without one.
const webhookEndpointSchema = new mongoose.Schema(
	{
		url: { type: String, required: true, trim: true },
		description: { type: String, trim: true, default: "" },
		events: { type: [String], default: undefined },
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter" },
		// The signing secret, whsec_ and base64 (lib/webhook-signing.js). It has to be readable to sign with, like an
		// SES key: it only proves to the receiver that an event came from FlockStack.
		secret: { type: String, required: true },
		// A rotated secret signs next to the new one until previousSecretUntil, so receivers can switch without missing events.
		previousSecret: { type: String },
		previousSecretUntil: { type: Date },
		enabled: { type: Boolean, default: true },
		// Turned off by FlockStack after failing for days, or a 410 Gone: why, and when. Turning it back on clears them.
		disabledReason: { type: String },
		disabledAt: { type: Date },
		// The first failure since the last success: failing past WEBHOOK_DISABLE_AFTER_MS turns the endpoint off.
		failingSince: { type: Date },
		lastSuccessAt: { type: Date },
		lastFailureAt: { type: Date },
		// Zapier, Make or the dashboard: who made it, shown in the list.
		source: { type: String, trim: true },
	},
	{ timestamps: true }
);

webhookEndpointSchema.plugin(accountScoped);
webhookEndpointSchema.index({ accountId: 1, createdAt: -1 });

export default mongoose.models.WebhookEndpoint || mongoose.model("WebhookEndpoint", webhookEndpointSchema);
