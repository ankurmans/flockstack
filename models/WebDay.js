import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

// What a newsletter's website did in one UTC day, counted as it happens (lib/web-analytics.js): never a row per visit, and
// nothing that names a visitor. views: page views. hll: a sketch of the day's distinct visitors, small numbers by register that
// can't be turned back into who was there, and kept for this day only. pages, referrers, countries: views by issue address,
// referring host (dots written as commas) and country code.
const webDaySchema = new mongoose.Schema(
	{
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		day: { type: String, required: true },
		views: { type: Number, default: 0 },
		hll: { type: mongoose.Schema.Types.Mixed },
		pages: { type: mongoose.Schema.Types.Mixed },
		referrers: { type: mongoose.Schema.Types.Mixed },
		countries: { type: mongoose.Schema.Types.Mixed },
	},
	{ timestamps: true }
);

webDaySchema.plugin(accountScoped);
webDaySchema.index({ newsletterId: 1, day: 1 }, { unique: true });

export default mongoose.models.WebDay || mongoose.model("WebDay", webDaySchema);
