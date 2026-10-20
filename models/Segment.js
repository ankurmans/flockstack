import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

// A saved audience: rules over a newsletter's contacts (lib/segment-rules.js), evaluated each time it's counted or
// sent to, so it follows the list. A static segment is a saved list instead: the contacts a segment matched when it was
// saved (SegmentMember), and its rules are the one condition "on this list".
const segmentSchema = new mongoose.Schema(
	{
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		name: { type: String, required: true, trim: true },
		description: { type: String, trim: true },
		rules: { type: mongoose.Schema.Types.Mixed, required: true },
		kind: { type: String, enum: ["dynamic", "static"], default: "dynamic" },
		// A static segment fills in over several jobs when the list is large (lib/segment-snapshots.js): building, then
		// ready, or failed. A dynamic segment has none of these.
		buildStatus: { type: String, enum: ["building", "ready", "failed"] },
		// The rules being saved, and where the walk over their contacts has got to.
		snapshotRules: { type: mongoose.Schema.Types.Mixed },
		snapshotTotal: { type: Number },
		memberCount: { type: Number },
		buildCursor: { type: String },
		buildError: { type: String },
		buildAttempts: { type: Number },
		lockedUntil: { type: Date },
		snapshotAt: { type: Date },
	},
	{ timestamps: true }
);

segmentSchema.plugin(accountScoped);
segmentSchema.index({ newsletterId: 1, name: 1 }, { unique: true });

export default mongoose.models.Segment || mongoose.model("Segment", segmentSchema);
