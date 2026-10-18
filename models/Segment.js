import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

// A saved audience: rules over a newsletter's contacts (lib/segment-rules.js), evaluated each time it's counted or
// sent to, so it follows the list.
const segmentSchema = new mongoose.Schema(
	{
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		name: { type: String, required: true, trim: true },
		description: { type: String, trim: true },
		rules: { type: mongoose.Schema.Types.Mixed, required: true },
	},
	{ timestamps: true }
);

segmentSchema.plugin(accountScoped);
segmentSchema.index({ newsletterId: 1, name: 1 }, { unique: true });

export default mongoose.models.Segment || mongoose.model("Segment", segmentSchema);
