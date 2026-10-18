import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

// A file in an export's ZIP: its bytes sit in private storage under keys, one object per part, and its size and CRC-32
// are known before the download starts. kind image: fetched from the account's uploads in a later step.
const exportFileSchema = new mongoose.Schema(
	{
		exportId: { type: mongoose.Schema.Types.ObjectId, ref: "AccountExport", required: true },
		path: { type: String, required: true },
		// Where it sorts in the ZIP: manifest and README first.
		order: { type: String, required: true },
		kind: { type: String, enum: ["file", "image"], default: "file" },
		size: { type: Number, default: 0 },
		crc: { type: Number, default: 0 },
		keys: { type: [String], default: undefined },
		// What the manifest says about it: a campaign's title and date, an image's address.
		meta: { type: mongoose.Schema.Types.Mixed },
		state: { type: String, enum: ["pending", "done", "missing"], default: "done" },
		error: { type: String },
	},
	{ timestamps: true }
);

exportFileSchema.plugin(accountScoped);
exportFileSchema.index({ exportId: 1, path: 1 }, { unique: true });
exportFileSchema.index({ exportId: 1, order: 1 });
exportFileSchema.index({ exportId: 1, state: 1 });

export default mongoose.models.ExportFile || mongoose.model("ExportFile", exportFileSchema);
