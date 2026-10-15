import mongoose from "mongoose";

// The never-email list every account shares (lib/global-suppressions.js): addresses an email provider said don't exist,
// and spam traps. An address is only ever its keyed hash, and nothing names the account or the newsletter it came from.
const globalSuppressionSchema = new mongoose.Schema(
	{
		emailHash: { type: String, required: true, unique: true },
		reason: { type: String, enum: ["bounce", "trap"], required: true },
		// The provider's type and status code, like bounce/5.1.1: never its words, which can quote the address.
		detail: { type: String },
		// Hard bounces only: MongoDB deletes the entry once it's past. Traps have none and stay.
		expiresAt: { type: Date },
	},
	{ timestamps: true }
);

globalSuppressionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
// The admin page's counts.
globalSuppressionSchema.index({ reason: 1, expiresAt: 1 });

export default mongoose.models.GlobalSuppression || mongoose.model("GlobalSuppression", globalSuppressionSchema);
