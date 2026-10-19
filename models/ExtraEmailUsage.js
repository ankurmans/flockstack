import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

// The extra emails an account sent in one month of its plan, past the plan's emails (lib/extra-emails.js), and how many
// of them Polar has been told about. counted grows as batches send; reported is what Polar has taken. pending is a report
// on its way: its event id is made from its range, so sending it again after a failure can't count twice at Polar, and
// no other report starts until it's settled. due: counted or pending is ahead of reported, for the hourly job. warnedAt
// and reachedAt: the owner's emails at 80% and 100% of the month's limit, once each.
const extraEmailUsageSchema = new mongoose.Schema(
	{
		periodStart: { type: Date, required: true },
		periodEnd: { type: Date },
		counted: { type: Number, default: 0, min: 0 },
		reported: { type: Number, default: 0, min: 0 },
		pending: {
			from: { type: Number },
			to: { type: Number },
			at: { type: Date },
		},
		due: { type: Boolean },
		reportedAt: { type: Date },
		warnedAt: { type: Date },
		reachedAt: { type: Date },
	},
	{ timestamps: true }
);

extraEmailUsageSchema.plugin(accountScoped);
extraEmailUsageSchema.index({ accountId: 1, periodStart: 1 }, { unique: true });
extraEmailUsageSchema.index({ due: 1 }, { sparse: true });

export default mongoose.models.ExtraEmailUsage || mongoose.model("ExtraEmailUsage", extraEmailUsageSchema);
