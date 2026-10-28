import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

// A URL a briefing has already taken in, so the next run only has what is new. urlHash is the SHA-256 of the canonical URL
// (lib/briefings/), storyKey the story it went into. Kept SEEN_RETENTION_DAYS (lib/briefing-rules.js).
const briefingSeenSchema = new mongoose.Schema(
	{
		briefingId: { type: mongoose.Schema.Types.ObjectId, ref: "Briefing", required: true },
		urlHash: { type: String, required: true },
		storyKey: { type: String },
		firstSeenAt: { type: Date, required: true },
	},
	{ timestamps: false }
);

briefingSeenSchema.plugin(accountScoped);
briefingSeenSchema.index({ briefingId: 1, urlHash: 1 }, { unique: true });
briefingSeenSchema.index({ firstSeenAt: 1 });

export default mongoose.models.BriefingSeen || mongoose.model("BriefingSeen", briefingSeenSchema);
