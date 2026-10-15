import mongoose from "mongoose";
import { accountScoped } from "../lib/account-scope.js";

// Per account: an address that bounced or complained is never emailed again from any of its newsletters.
// provider: the email provider refused it for the account, for a reason it recorded on its side.
const suppressionSchema = new mongoose.Schema(
	{
		email: { type: String, required: true, lowercase: true, trim: true },
		reason: { type: String, enum: ["bounce", "complaint", "manual", "provider"], required: true },
		detail: { type: String },
	},
	{ timestamps: true }
);

suppressionSchema.plugin(accountScoped);
suppressionSchema.index({ accountId: 1, email: 1 }, { unique: true });
suppressionSchema.index({ accountId: 1, createdAt: -1 });

export default mongoose.models.Suppression || mongoose.model("Suppression", suppressionSchema);
