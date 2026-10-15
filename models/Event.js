import mongoose from "mongoose";
import { accountScoped } from "../lib/account-scope.js";

const eventSchema = new mongoose.Schema(
	{
		type: { type: String, required: true },
		providerMessageId: { type: String, index: true },
		// The provider's id for the event, where it gives one: a redelivered event isn't recorded twice.
		providerEventId: { type: String },
		messageId: { type: mongoose.Schema.Types.ObjectId, ref: "Message" },
		campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign" },
		email: { type: String, lowercase: true, trim: true },
		occurredAt: { type: Date, default: Date.now },
		data: { type: mongoose.Schema.Types.Mixed },
	},
	{ timestamps: true }
);

eventSchema.plugin(accountScoped);
// Only problem events are stored (see lib/email-events.js); deliveries and engagement live on Message.
eventSchema.index({ campaignId: 1, type: 1 });
eventSchema.index({ accountId: 1, occurredAt: -1 });
eventSchema.index({ providerEventId: 1 }, { unique: true, partialFilterExpression: { providerEventId: { $type: "string" } } });

export default mongoose.models.Event || mongoose.model("Event", eventSchema);
