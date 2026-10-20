import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

export const BULK_REMOVAL_KINDS = ["tag", "field"];
export const BULK_REMOVAL_STATUSES = ["running", "done", "failed"];

// A deleted tag or custom field coming off a large list's contacts, a chunk at a time, in background jobs
// (lib/bulk-removal.js). cursor is the last contact done, in _id order, so the next step picks up after it.
const bulkRemovalSchema = new mongoose.Schema(
	{
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		kind: { type: String, enum: BULK_REMOVAL_KINDS, required: true },
		// The tag, or the field's key.
		name: { type: String, required: true },
		// What the dashboard calls it: the tag, or the field's label.
		label: { type: String },
		status: { type: String, enum: BULK_REMOVAL_STATUSES, default: "running" },
		// Contacts that had it when it was deleted, and those it's off so far.
		total: { type: Number, default: 0 },
		removed: { type: Number, default: 0 },
		cursor: { type: String },
		// Steps that threw since the last one that didn't: past three, the removal fails.
		attempts: { type: Number, default: 0 },
		// A step in progress holds the removal until then, so a job delivered twice doesn't run twice at once.
		lockedUntil: { type: Date },
		error: { type: String },
		finishedAt: { type: Date },
	},
	{ timestamps: true }
);

bulkRemovalSchema.plugin(accountScoped);
bulkRemovalSchema.index({ accountId: 1, newsletterId: 1, status: 1 });

export default mongoose.models.BulkRemoval || mongoose.model("BulkRemoval", bulkRemovalSchema);
