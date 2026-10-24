import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

// A group of content items that belong together (lib/content-batches.js): a campaign, a launch, a month. It may carry a
// recurring pattern, the funnel stages in the order they repeat and when slots fall, which only an explicit apply uses to
// give items planned days.
const editorialBatchSchema = new mongoose.Schema(
	{
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		name: { type: String, required: true, trim: true },
		description: { type: String, trim: true, default: "" },
		externalId: { type: String, trim: true },
		status: { type: String, enum: ["active", "archived"], default: "active" },
		pattern: {
			stages: { type: [String], default: undefined },
			cadence: {
				weekdays: { type: [Number], default: undefined },
				everyDays: { type: Number },
				perDay: { type: Number },
				time: { type: String },
				timeZone: { type: String },
			},
		},
		// The last time the batch was put in front of the owner as a whole.
		review: {
			requestedAt: { type: Date },
			requestedBy: { type: String },
		},
		createdBy: { type: String },
	},
	{ timestamps: true }
);

editorialBatchSchema.plugin(accountScoped);
editorialBatchSchema.index({ accountId: 1, externalId: 1 }, { unique: true, partialFilterExpression: { externalId: { $type: "string" } } });
editorialBatchSchema.index({ newsletterId: 1, createdAt: -1 });

export default mongoose.models.EditorialBatch || mongoose.model("EditorialBatch", editorialBatchSchema);
