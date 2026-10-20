import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";
import { SERIES_RUN_STATUSES } from "../lib/series-rules.js";

// One run of a series: the history, and the lock that keeps a run from happening twice. slot is the moment the run was due
// (a manual run's own), and a series has one run for each slot.
const seriesRunSchema = new mongoose.Schema(
	{
		seriesId: { type: mongoose.Schema.Types.ObjectId, ref: "SeriesPlan", required: true },
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		slot: { type: String, required: true },
		isManual: { type: Boolean, default: false },
		status: { type: String, enum: SERIES_RUN_STATUSES, default: "running" },
		reason: { type: String },
		campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign" },
		itemCount: { type: Number, default: 0 },
		finishedAt: { type: Date },
	},
	{ timestamps: true }
);

seriesRunSchema.plugin(accountScoped);
seriesRunSchema.index({ seriesId: 1, slot: 1 }, { unique: true });
seriesRunSchema.index({ seriesId: 1, createdAt: -1 });

export default mongoose.models.SeriesRun || mongoose.model("SeriesRun", seriesRunSchema);
