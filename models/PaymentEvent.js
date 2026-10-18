import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

// Stripe events the creator-payments webhook handled (lib/payments/events.js), by Stripe's event id: Stripe sends an
// event again until it gets a 2xx, and sometimes twice. processedAt is set once the handler finished, so an event whose
// handler failed is handled again on the retry.
const paymentEventSchema = new mongoose.Schema(
	{
		eventId: { type: String, required: true },
		type: { type: String, required: true },
		processedAt: { type: Date },
	},
	{ timestamps: true }
);

paymentEventSchema.plugin(accountScoped);
paymentEventSchema.index({ eventId: 1 }, { unique: true });
paymentEventSchema.index({ createdAt: 1 });

export default mongoose.models.PaymentEvent || mongoose.model("PaymentEvent", paymentEventSchema);
