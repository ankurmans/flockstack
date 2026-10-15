import mongoose from "mongoose";

// What stays of a deleted account (lib/deletion-records.js): its owner's email as a keyed hash, so the same email
// signing up again can be noticed, and the dates. Nothing the account held. Stripe keeps its own billing history.
const deletionRecordSchema = new mongoose.Schema({
	accountId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
	emailHash: { type: String, required: true, index: true },
	accountCreatedAt: { type: Date },
	requestedAt: { type: Date, required: true },
	purgedAt: { type: Date },
});

export default mongoose.models.DeletionRecord || mongoose.model("DeletionRecord", deletionRecordSchema);
