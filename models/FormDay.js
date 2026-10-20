import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

// What a form did in one UTC day, counted as it happens: never a row per view or signup. day is YYYY-MM-DD.
const formDaySchema = new mongoose.Schema(
	{
		formId: { type: mongoose.Schema.Types.ObjectId, ref: "Form", required: true },
		day: { type: String, required: true },
		views: { type: Number, default: 0 },
		signups: { type: Number, default: 0 },
	},
	{ timestamps: true }
);

formDaySchema.plugin(accountScoped);
formDaySchema.index({ formId: 1, day: 1 }, { unique: true });

export default mongoose.models.FormDay || mongoose.model("FormDay", formDaySchema);
