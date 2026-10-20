import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";
import { SERIES_FREQUENCIES, SERIES_MODES } from "../lib/series-rules.js";

// A recurring series of a newsletter (lib/series.js): on its schedule, the feed's new items become an issue, left as a
// draft for review or sent. nextRunAt is the moment the next run is due, moved forward by the run that claims it;
// lastItemAt and seenIds are what has gone into issues already, so the next one has only what is new.
const seriesPlanSchema = new mongoose.Schema(
	{
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		name: { type: String, required: true, trim: true },
		feedUrl: { type: String, required: true, trim: true },
		schedule: {
			frequency: { type: String, enum: SERIES_FREQUENCIES, required: true },
			// Weekdays for weekly, 0 (Sunday) to 6.
			days: { type: [Number], default: undefined },
			dayOfMonth: { type: Number },
			hour: { type: Number, required: true },
			timeZone: { type: String, default: "UTC" },
		},
		mode: { type: String, enum: SERIES_MODES, default: "draft" },
		// {{date}}, {{first_title}} and {{count}} are filled in when an issue is made.
		subject: { type: String, required: true, trim: true },
		previewText: { type: String, trim: true, default: "" },
		count: { type: Number, default: 3 },
		order: { type: String, enum: ["newest", "oldest"], default: "newest" },
		image: { type: Boolean, default: true },
		excerpt: { type: Boolean, default: true },
		date: { type: Boolean, default: true },
		// Rich text above the items.
		intro: { type: String, default: "" },
		active: { type: Boolean, default: false },
		nextRunAt: { type: Date },
		lastRunAt: { type: Date },
		lastItemAt: { type: Date },
		seenIds: { type: [String], default: undefined },
	},
	{ timestamps: true }
);

seriesPlanSchema.plugin(accountScoped);
seriesPlanSchema.index({ newsletterId: 1, createdAt: 1 });
// The job reads the active series that are due.
seriesPlanSchema.index({ active: 1, nextRunAt: 1 });

export default mongoose.models.SeriesPlan || mongoose.model("SeriesPlan", seriesPlanSchema);
