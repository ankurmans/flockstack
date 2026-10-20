import mongoose from "../lib/docdb/index.js";
import { CUSTOM_STATUSES, choiceIds } from "../lib/custom-choices.js";

// A lead from the Custom plan's form (/custom, lib/custom-requests.js): who asked, what they send and what they would
// need. The region is the Worker that took it; each region keeps its own. Not an account's data: nobody has an account
// to ask with, so the admins read it, and it goes two years after its last change.
const customRequestSchema = new mongoose.Schema(
	{
		name: { type: String, required: true },
		email: { type: String, required: true },
		company: { type: String, required: true },
		website: { type: String },
		platform: { type: String },
		subscribers: { type: String },
		emailsPerMonth: { type: String },
		needs: { type: [String], default: [] },
		otherNeed: { type: String },
		timeline: { type: String },
		message: { type: String },
		region: { type: String, required: true },
		status: { type: String, enum: choiceIds(CUSTOM_STATUSES), default: "new" },
		notes: { type: String },
	},
	{ timestamps: true }
);

customRequestSchema.index({ createdAt: -1 });
customRequestSchema.index({ updatedAt: 1 });

export default mongoose.models.CustomRequest || mongoose.model("CustomRequest", customRequestSchema);
