import mongoose from "../lib/docdb/index.js";
const schema = new mongoose.Schema({
	payload: { type: mongoose.Schema.Types.Mixed, required: true },
	draftHash: { type: String }, claimHash: { type: String },
	revision: { type: Number, default: 1 },
	status: { type: String, enum: ["pending", "claiming", "claimed"], default: "pending" },
	expiresAt: { type: Date, required: true }, leaseUntil: Date,
	claimedBy: mongoose.Schema.Types.ObjectId, claimedAt: Date,
	result: mongoose.Schema.Types.Mixed,
}, { timestamps: true });
schema.index({ expiresAt: 1 });
export default mongoose.models.AgentWorkspace || mongoose.model("AgentWorkspace", schema);
