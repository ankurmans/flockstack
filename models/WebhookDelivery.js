import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

export const WEBHOOK_DELIVERY_STATUSES = ["pending", "delivered", "failed"];

// One event on its way to one endpoint, with its last attempt. Only the latest deliveries of an endpoint are kept
// (MAX_DELIVERIES_PER_ENDPOINT in lib/webhooks.js): D1 has a size cap, and this is a log, not an archive.
const webhookDeliverySchema = new mongoose.Schema(
	{
		endpointId: { type: mongoose.Schema.Types.ObjectId, ref: "WebhookEndpoint", required: true },
		// The webhook-id header: the same for every endpoint the event went to, every retry and a resend, so a receiver can
		// tell a repeat from a new event.
		messageId: { type: String, required: true },
		type: { type: String, required: true },
		// The JSON body, exactly as it's signed and sent.
		payload: { type: String, required: true },
		status: { type: String, enum: WEBHOOK_DELIVERY_STATUSES, default: "pending" },
		test: { type: Boolean },
		attempts: { type: Number, default: 0 },
		lastAttemptAt: { type: Date },
		nextAttemptAt: { type: Date },
		deliveredAt: { type: Date },
		// The last attempt's answer: its status code and the start of its body, or why there was none.
		responseStatus: { type: Number },
		responseBody: { type: String },
		error: { type: String },
	},
	{ timestamps: true }
);

webhookDeliverySchema.plugin(accountScoped);
webhookDeliverySchema.index({ endpointId: 1, createdAt: -1, _id: -1 });

export default mongoose.models.WebhookDelivery || mongoose.model("WebhookDelivery", webhookDeliverySchema);
