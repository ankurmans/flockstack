import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";
import { BRIEFING_RUN_STATUSES, BRIEFING_STAGES, CHECK_STATUSES, HOLD_REASONS, SECTION_STATUSES, SOURCE_KINDS, STORY_KINDS } from "../lib/briefing-rules.js";

// One run of a briefing: its history (stories, model calls and their cost, checks) and the lock that keeps a run from happening
// twice. slot is the local date the run was due (manual:<ISO time> for a manual run), and a briefing has one run per slot.
// stories keep the ranker's features, so a verdict given after the run ends can still train it. previewImage is the source page's
// og:image address, shown only as a link preview on the owner's pages, never in the issue.
// work holds what one stage hands the next while the run goes on (items, records, the draft); it is dropped when the run ends.
const briefingRunSchema = new mongoose.Schema(
	{
		briefingId: { type: mongoose.Schema.Types.ObjectId, ref: "Briefing", required: true },
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		slot: { type: String, required: true },
		isManual: { type: Boolean, default: false },
		stage: { type: String, enum: BRIEFING_STAGES, default: "discover" },
		status: { type: String, enum: BRIEFING_RUN_STATUSES, default: "running" },
		counts: { queries: { type: Number, default: 0 }, results: { type: Number, default: 0 }, candidates: { type: Number, default: 0 }, fresh: { type: Number, default: 0 }, groups: { type: Number, default: 0 }, shortlisted: { type: Number, default: 0 }, picked: { type: Number, default: 0 } },
		queries: [{ _id: false, text: String, angle: String }],
		// A limit hit, a path robots.txt refused, a provider error: what discovery could not do, for the owner's email.
		discoveryNotes: [{ _id: false, provider: String, problem: String, scope: String, until: Date }],
		stories: [{ _id: false, storyKey: String, externalId: String, kind: { type: String, enum: STORY_KINDS }, title: String, url: String, sourceKind: { type: String, enum: SOURCE_KINDS }, score: Number, foundBy: [String], sources: [String], features: { type: mongoose.Schema.Types.Mixed }, sectionId: String, previewImage: String }],
		// Per section of a sectioned briefing: what was written and what it cost.
		sections: [{ _id: false, id: String, title: String, status: { type: String, enum: SECTION_STATUSES }, items: Number, costUsd: Number, problem: String }],
		calls: [{ _id: false, step: String, sectionId: String, provider: String, model: String, inputTokens: Number, outputTokens: Number, costUsd: Number, costFrom: { type: String, enum: ["provider", "price_table"] } }],
		costUsd: { type: Number, default: 0 },
		checks: [{ _id: false, id: String, status: { type: String, enum: CHECK_STATUSES }, message: String }],
		languages: [{ _id: false, language: String, status: String, problem: String }],
		thin: { type: Boolean, default: false },
		// Set when the run made a draft where its review mode would have sent.
		heldReason: { type: String, enum: HOLD_REASONS },
		// When delivery queued this run's issue for sending by itself; the daily cap counts these.
		autoSentAt: { type: Date },
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
