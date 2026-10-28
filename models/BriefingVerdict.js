import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";
import { VERDICTS } from "../lib/briefing-rules.js";

// The owner's keep or drop on a story a briefing found: the ranker learns its weights from these (lib/briefings/rank.js).
// features is what the ranker saw when it scored the story, so a refit does not need the run. linkId is the single-use id of the
// email link that recorded it, unique so a link counts once.
const briefingVerdictSchema = new mongoose.Schema(
	{
		briefingId: { type: mongoose.Schema.Types.ObjectId, ref: "Briefing", required: true },
		runId: { type: mongoose.Schema.Types.ObjectId, ref: "BriefingRun", required: true },
		storyKey: { type: String, required: true },
		url: { type: String },
		verdict: { type: String, enum: VERDICTS, required: true },
		features: { type: mongoose.Schema.Types.Mixed },
		linkId: { type: String },
		decidedBy: { type: String },
		decidedAt: { type: Date, required: true },
	},
	{ timestamps: false }
);

briefingVerdictSchema.plugin(accountScoped);
briefingVerdictSchema.index({ briefingId: 1, runId: 1, storyKey: 1 }, { unique: true });
briefingVerdictSchema.index({ briefingId: 1, decidedAt: -1 });
briefingVerdictSchema.index({ linkId: 1 }, { unique: true, partialFilterExpression: { linkId: { $type: "string" } } });

export default mongoose.models.BriefingVerdict || mongoose.model("BriefingVerdict", briefingVerdictSchema);
