import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";
import { BRIEFING_RUN_STATUSES, BRIEFING_STAGES, CHECK_STATUSES } from "../lib/briefing-rules.js";

// One run of a briefing: its history (stories, model calls and their cost, checks) and the lock that keeps a run from happening
// twice. slot is the local date the run was due (manual:<ISO time> for a manual run), and a briefing has one run per slot.
// work holds what one stage hands the next while the run goes on (items, records, the draft); it is dropped when the run ends.
const briefingRunSchema = new mongoose.Schema(
	{
		briefingId: { type: mongoose.Schema.Types.ObjectId, ref: "Briefing", required: true },
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		slot: { type: String, required: true },
		isManual: { type: Boolean, default: false },
		stage: { type: String, enum: BRIEFING_STAGES, default: "collect" },
		status: { type: String, enum: BRIEFING_RUN_STATUSES, default: "running" },
		counts: { sources: { type: Number, default: 0 }, fetched: { type: Number, default: 0 }, fresh: { type: Number, default: 0 }, groups: { type: Number, default: 0 }, picked: { type: Number, default: 0 } },
		sourceErrors: [{ _id: false, sourceId: String, problem: String }],
		stories: [{ _id: false, externalId: String, title: String, url: String, score: Number, sources: [String] }],
		calls: [{ _id: false, step: String, provider: String, model: String, inputTokens: Number, outputTokens: Number, costUsd: Number, costFrom: { type: String, enum: ["provider", "price_table"] } }],
		costUsd: { type: Number, default: 0 },
		checks: [{ _id: false, id: String, status: { type: String, enum: CHECK_STATUSES }, message: String }],
		campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign" },
		error: { type: String },
		work: { type: mongoose.Schema.Types.Mixed },
		touchedAt: { type: Date },
		startedAt: { type: Date },
		finishedAt: { type: Date },
	},
	{ timestamps: true }
);

briefingRunSchema.plugin(accountScoped);
briefingRunSchema.index({ briefingId: 1, slot: 1 }, { unique: true });
briefingRunSchema.index({ briefingId: 1, createdAt: -1 });
// The engine resumes the runs still going.
briefingRunSchema.index({ status: 1, touchedAt: 1 });

export default mongoose.models.BriefingRun || mongoose.model("BriefingRun", briefingRunSchema);
