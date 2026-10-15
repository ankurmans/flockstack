import mongoose from "mongoose";
import { accountScoped } from "../lib/account-scope.js";

// What stays of a contact deleted after it unsubscribed, bounced or complained (lib/contacts.js): its email as a keyed
// hash and its status, so the address added to the newsletter again, by import, the API or a signup, is never emailed.
const deletedContactSchema = new mongoose.Schema(
	{
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		emailHash: { type: String, required: true },
		status: { type: String, enum: ["unsubscribed", "bounced", "complained"], required: true },
	},
	{ timestamps: true }
);

deletedContactSchema.plugin(accountScoped);
// The upsert's whole filter, so MongoDB retries two deletes of the same contact instead of failing one.
deletedContactSchema.index({ accountId: 1, newsletterId: 1, emailHash: 1 }, { unique: true });

export default mongoose.models.DeletedContact || mongoose.model("DeletedContact", deletedContactSchema);
