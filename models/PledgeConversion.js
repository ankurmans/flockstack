import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

// notifying: telling each pledger the day of their first charge. waiting: until that day. charging: creating the subscriptions.
export const CONVERSION_STATUSES = ["notifying", "waiting", "charging", "done", "canceled", "failed"];

// The writer's "start charging" for a newsletter's pledges, run in QStash steps (lib/pledge-conversion.js). Each step saves its
// place in `cursor`, so a step that dies or is delivered twice picks up where the last one stopped, and nobody is told or charged twice.
const pledgeConversionSchema = new mongoose.Schema(
	{
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		// Only this tier's pledges, or every tier's.
		tierId: { type: String },
		status: { type: String, enum: CONVERSION_STATUSES, default: "notifying" },
		noticeDays: { type: Number, required: true },
		chargeAt: { type: Date, required: true },
		// Charge each pledger what they pledged, or the tier's price now.
		honorPledgedPrice: { type: Boolean, default: true },
		total: { type: Number, default: 0 },
		cursor: { type: String },
		attempts: { type: Number, default: 0 },
		lockedUntil: { type: Date },
		counts: {
			notified: { type: Number },
			converted: { type: Number },
			failed: { type: Number },
			canceled: { type: Number },
		},
		error: { type: String },
		finishedAt: { type: Date },
	},
	{ timestamps: true }
);

pledgeConversionSchema.plugin(accountScoped);
pledgeConversionSchema.index({ accountId: 1, newsletterId: 1, status: 1 });
pledgeConversionSchema.index({ status: 1, updatedAt: 1 });

export default mongoose.models.PledgeConversion || mongoose.model("PledgeConversion", pledgeConversionSchema);
