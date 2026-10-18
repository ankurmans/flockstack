import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

export const EXPORT_STATUSES = ["queued", "running", "ready", "failed", "expired"];

// One export of everything an account has (lib/account-export.js): built in steps by background jobs, which write the
// files to private storage. state is where the next step picks up. Its files are ExportFile documents.
const accountExportSchema = new mongoose.Schema(
	{
		requestedBy: { type: mongoose.Schema.Types.ObjectId },
		via: { type: String },
		status: { type: String, enum: EXPORT_STATUSES, default: "queued" },
		error: { type: String },
		state: { type: mongoose.Schema.Types.Mixed },
		// Steps that threw since the last one that didn't: past three, the export fails.
		attempts: { type: Number, default: 0 },
		// A step in progress holds the export until then, so a job delivered twice doesn't run twice at once.
		lockedUntil: { type: Date },
		counts: {
			newsletters: { type: Number, default: 0 },
			contacts: { type: Number, default: 0 },
			campaigns: { type: Number, default: 0 },
			images: { type: Number, default: 0 },
			missingImages: { type: Number, default: 0 },
			bytes: { type: Number, default: 0 },
		},
		// Each ZIP of a large export starts at one of these (ExportFile.order).
		volumeStarts: { type: [String], default: undefined },
		readyAt: { type: Date },
		expiresAt: { type: Date },
		emailedAt: { type: Date },
	},
	{ timestamps: true }
);

accountExportSchema.plugin(accountScoped);
accountExportSchema.index({ accountId: 1, createdAt: -1 });
accountExportSchema.index({ status: 1, expiresAt: 1 });

export default mongoose.models.AccountExport || mongoose.model("AccountExport", accountExportSchema);
