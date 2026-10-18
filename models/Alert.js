import mongoose from "../lib/docdb/index.js";

// One document per alert kind and account: lastSentAt enforces the cooldown between repeated alerts, and
// telegramSentAt Telegram's. Platform alerts (the rate limiter) have no account.
const alertSchema = new mongoose.Schema(
	{
		accountId: { type: mongoose.Schema.Types.ObjectId, ref: "Account" },
		key: { type: String, required: true },
		title: { type: String },
		lastSentAt: { type: Date },
		telegramSentAt: { type: Date },
	},
	{ timestamps: true }
);

alertSchema.index({ accountId: 1, key: 1 }, { unique: true });

export default mongoose.models.Alert || mongoose.model("Alert", alertSchema);
