import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

// active: counts as a recommendation (it shows only while the recommended newsletter can take it too, lib/recommendation-rules.js
// getRecommendationState). removed: taken out, with the reason its owner reads and who did it: the recommender, the recommended
// newsletter's owner or the system. A removed pair keeps its counts and comes back with a new pitch if the recommender adds it again.
export const RECOMMENDATION_STATUSES = ["active", "removed"];
export const REMOVED_BY = ["recommender", "recommended", "system"];

// accountId is the recommender's. The recommended newsletter belongs to another account of the same region.
const recommendationSchema = new mongoose.Schema(
	{
		recommenderId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		recommendedId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		recommendedAccountId: { type: mongoose.Schema.Types.ObjectId, required: true },
		// The recommender's own words, plain text.
		pitch: { type: String, trim: true, required: true },
		position: { type: Number, default: 0 },
		status: { type: String, enum: RECOMMENDATION_STATUSES, default: "active" },
		reason: { type: String, trim: true },
		removedBy: { type: String, enum: REMOVED_BY },
		removedAt: { type: Date },
		// Counted without any personal data: pages that showed it, new contacts it brought to the recommended newsletter, and
		// those that confirmed.
		stats: {
			impressions: { type: Number, default: 0 },
			signups: { type: Number, default: 0 },
			confirmed: { type: Number, default: 0 },
		},
	},
	{ timestamps: true }
);

recommendationSchema.plugin(accountScoped);
// A newsletter recommends another once.
recommendationSchema.index({ recommenderId: 1, recommendedId: 1 }, { unique: true });
// Who recommends a newsletter, for its owner's page and its settings.
recommendationSchema.index({ recommendedId: 1, status: 1, createdAt: -1 });
// A deleted account takes the recommendations of others to it out.
recommendationSchema.index({ recommendedAccountId: 1, status: 1 });

export default mongoose.models.Recommendation || mongoose.model("Recommendation", recommendationSchema);
