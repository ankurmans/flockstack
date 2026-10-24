import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

// The editable content of a content item as it was after each change (lib/content-items.js), so an earlier state can be
// read and restored. The last 50 per item stay; the latest is the item as it is now.
const contentRevisionSchema = new mongoose.Schema(
	{
		itemId: { type: mongoose.Schema.Types.ObjectId, ref: "ContentItem", required: true },
		version: { type: Number, required: true },
		// create: the first state. edit: a change. restore: an earlier state brought back.
		reason: { type: String, enum: ["create", "edit", "restore"], default: "edit" },
		changedFields: { type: [String], default: undefined },
		// Who made the change: a key, an app or the dashboard, by name.
		by: { type: String },
		snapshot: { type: mongoose.Schema.Types.Mixed, required: true },
	},
	{ timestamps: true }
);

contentRevisionSchema.plugin(accountScoped);
contentRevisionSchema.index({ itemId: 1, createdAt: -1 });

export default mongoose.models.ContentRevision || mongoose.model("ContentRevision", contentRevisionSchema);
