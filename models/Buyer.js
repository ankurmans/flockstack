import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

// Someone who bought from the account, kept once however many orders they make. A buyer isn't a subscriber: they are on a
// newsletter's list only if they ticked the box at checkout.
const buyerSchema = new mongoose.Schema(
	{
		email: { type: String, required: true, lowercase: true, trim: true },
		name: { type: String, trim: true },
		orderCount: { type: Number, default: 0 },
		firstOrderAt: { type: Date },
		lastOrderAt: { type: Date },
	},
	{ timestamps: true }
);

buyerSchema.plugin(accountScoped);
buyerSchema.index({ accountId: 1, email: 1 }, { unique: true });

export default mongoose.models.Buyer || mongoose.model("Buyer", buyerSchema);
