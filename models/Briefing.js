import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";
import { BRIEFING_REVIEW_MODES, BRIEFING_SOURCE_KINDS, BRIEFING_STATUSES, DEFAULT_BUDGET_USD, DEFAULT_MAX_STORIES, DEFAULT_MIN_SCORE } from "../lib/briefing-rules.js";

// A newsletter's briefing (docs/BRIEFINGS-DESIGN.md): on its schedule the engine reads the sources, picks the stories for the
// audience, writes a sourced issue in the style guide's voice, checks it and leaves it as a draft. nextRunAt is the next run due,
// moved forward by the run that claims it; manualRunAt is a run asked for with run_briefing, taken by the engine's next tick.
const stepSchema = { keyId: { type: mongoose.Schema.Types.ObjectId, ref: "AiProviderKey" }, model: { type: String, trim: true } };

const briefingSchema = new mongoose.Schema(
	{
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		name: { type: String, required: true, trim: true },
		status: { type: String, enum: BRIEFING_STATUSES, default: "paused" },
		sources: [
			{
				_id: false,
				id: { type: String, required: true },
				kind: { type: String, enum: BRIEFING_SOURCE_KINDS, required: true },
				url: { type: String, required: true, trim: true },
				label: { type: String, trim: true, default: "" },
				weight: { type: Number, default: 1 },
			},
		],
		schedule: {
			// Weekdays, 1 (Monday) to 7 (Sunday).
			days: { type: [Number], default: undefined },
			time: { type: String, default: "06:00" },
			timeZone: { type: String, default: "UTC" },
		},
		audience: { type: String, default: "" },
		styleGuide: { type: String, default: "" },
		// The issue is written in the first; the others are offered to readers through reader translation.
		languages: { type: [String], default: undefined },
		maxStories: { type: Number, default: DEFAULT_MAX_STORIES },
		minScore: { type: Number, default: DEFAULT_MIN_SCORE },
		steps: { triage: stepSchema, extract: stepSchema, write: stepSchema, check: stepSchema },
		// Per model, in USD per million tokens, over the engine's own table (lib/briefings/prices.js).
		prices: [{ _id: false, model: { type: String, required: true }, inputPerMillion: { type: Number }, outputPerMillion: { type: Number } }],
		budgetUsd: { type: Number, default: DEFAULT_BUDGET_USD },
		reviewMode: { type: String, enum: BRIEFING_REVIEW_MODES, default: "draft" },
		testEmail: { type: String, trim: true, lowercase: true },
		nextRunAt: { type: Date },
		manualRunAt: { type: Date },
		lastRunAt: { type: Date },
	},
	{ timestamps: true }
);

briefingSchema.plugin(accountScoped);
briefingSchema.index({ newsletterId: 1, createdAt: 1 });
// The engine reads the active briefings that are due, and the manual runs asked for.
briefingSchema.index({ status: 1, nextRunAt: 1 });
briefingSchema.index({ manualRunAt: 1 });

export default mongoose.models.Briefing || mongoose.model("Briefing", briefingSchema);
