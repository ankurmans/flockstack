import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

export const REDIRECT_SOURCES = ["import", "manual"];

// One redirect on a newsletter's website: requests for path answer 301 to `to` (lib/redirect-paths.js has both
// shapes). A post import adds one for each imported post's old address; the owner adds the rest by hand or by CSV.
const redirectSchema = new mongoose.Schema(
	{
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		path: { type: String, required: true },
		to: { type: String, required: true },
		source: { type: String, enum: REDIRECT_SOURCES, default: "manual" },
		// The import and issue an automatic one came from.
		importId: { type: mongoose.Schema.Types.ObjectId },
		campaignId: { type: mongoose.Schema.Types.ObjectId },
	},
	{ timestamps: true }
);

redirectSchema.plugin(accountScoped);
// proxy.js looks a request up by these two, so a website's lookups stay one indexed query.
redirectSchema.index({ newsletterId: 1, path: 1 }, { unique: true });
redirectSchema.index({ newsletterId: 1, createdAt: -1 });

export default mongoose.models.Redirect || mongoose.model("Redirect", redirectSchema);
