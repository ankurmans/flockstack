import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

// What a briefing has learned about a host it found stories on, so a new publisher earns a score over time.
const briefingPublisherSchema = new mongoose.Schema(
	{
		briefingId: { type: mongoose.Schema.Types.ObjectId, ref: "Briefing", required: true },
		host: { type: String, required: true },
		feedUrl: { type: String },
		seen: { type: Number, default: 0 },
		shortlisted: { type: Number, default: 0 },
		picked: { type: Number, default: 0 },
		kept: { type: Number, default: 0 },
		dropped: { type: Number, default: 0 },
		firstSeenAt: { type: Date, required: true },
		lastSeenAt: { type: Date },
	},
	{ timestamps: false }
);

briefingPublisherSchema.plugin(accountScoped);
briefingPublisherSchema.index({ briefingId: 1, host: 1 }, { unique: true });

export default mongoose.models.BriefingPublisher || mongoose.model("BriefingPublisher", briefingPublisherSchema);
