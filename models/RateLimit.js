import mongoose from "../lib/docdb/index.js";

// One counter per limit, caller and time window (lib/rate-limit.js): the database is what every Worker instance
// shares. expiresAt says when a window can't matter anymore, and is cleaned up as limits are checked.
const rateLimitSchema = new mongoose.Schema({
	key: { type: String, required: true, unique: true },
	count: { type: Number, default: 0 },
	expiresAt: { type: Date, required: true },
});

rateLimitSchema.index({ expiresAt: 1 });

export default mongoose.models.RateLimit || mongoose.model("RateLimit", rateLimitSchema);
