import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";
import { BRIEFING_REVIEW_MODES, BRIEFING_STATUSES, DEFAULT_BUDGET_USD, DEFAULT_MIN_SCORE, SECTION_FORMATS } from "../lib/briefing-rules.js";

// A newsletter's briefing (docs/BRIEFINGS-DESIGN.md): on its schedule the engine searches the web from the brief, picks the stories for the
// audience, writes a sourced issue in the style guide's voice, checks it and leaves it as a draft. nextRunAt is the next run due,
// moved forward by the run that claims it; manualRunAt is a run asked for with run_briefing, taken by the engine's next tick.
const stepSchema = { keyId: { type: mongoose.Schema.Types.ObjectId, ref: "AiProviderKey" }, model: { type: String, trim: true } };

const briefingSchema = new mongoose.Schema(
	{
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		name: { type: String, required: true, trim: true },
		status: { type: String, enum: BRIEFING_STATUSES, default: "paused" },
		// What to look for, instead of a list of sources: the engine searches the open web from it (docs/BRIEFINGS-DESIGN.md).
		brief: {
			topic: { type: String, trim: true, default: "" },
			audience: { type: String, default: "" },
			useful: { type: String, default: "" },
			examples: [{ _id: false, url: { type: String, required: true, trim: true }, note: { type: String, trim: true, default: "" } }],
		},
		// Hosts that add to a story's score and whose feeds are read each run; never a limit on what is searched.
		trustedOutlets: { type: [String], default: undefined },
		// Hosts never fetched for this briefing, whatever their robots.txt says.
		blockedHosts: { type: [String], default: undefined },
		discovery: {
			searchKeyId: { type: mongoose.Schema.Types.ObjectId, ref: "AiProviderKey" },
			candidateFeedKeyId: { type: mongoose.Schema.Types.ObjectId, ref: "AiProviderKey" },
			maxQueries: { type: Number },
			resultsPerQuery: { type: Number },
			maxCandidates: { type: Number },
			shortlist: { type: Number },
			followLinks: { type: Number },
			discoveryBudgetUsd: { type: Number },
		},
		schedule: {
			// Weekdays, 1 (Monday) to 7 (Sunday).
			days: { type: [Number], default: undefined },
			time: { type: String, default: "06:00" },
			timeZone: { type: String, default: "UTC" },
		},
		styleGuide: { type: String, default: "" },
		// The issue is written in the first; the others are offered to readers through reader translation.
		languages: { type: [String], default: undefined },
		stories: { minFull: { type: Number }, maxFull: { type: Number }, briefItems: { type: Number } },
		// The issue's sections in reading order, when set; without them the issue is full stories then brief items (stories).
		// priority decides which sections are written first when the budget runs short (1 first; the reading order otherwise).
		// budgetShare is the section's percent of the extract and write steps' shares.
		sections: [
			{
				_id: false,
				id: { type: String, required: true },
				title: { type: String, required: true, trim: true },
				purpose: { type: String, trim: true, default: "" },
				format: { type: String, enum: SECTION_FORMATS, required: true },
				maxItems: { type: Number, required: true },
				budgetShare: { type: Number },
				priority: { type: Number },
			},
		],
		minScore: { type: Number, default: DEFAULT_MIN_SCORE },
		steps: { query: stepSchema, triage: stepSchema, extract: stepSchema, write: stepSchema, check: stepSchema, translate: stepSchema },
		// Percent of budgetUsd per step (DEFAULT_STEP_BUDGETS when unset).
		stepBudgets: { query: Number, triage: Number, extract: Number, write: Number, check: Number, translate: Number },
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
