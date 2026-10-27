import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

const schema = new mongoose.Schema({
	newsletterId: { type: mongoose.Schema.Types.ObjectId, required: true },
	bookingId: { type: mongoose.Schema.Types.ObjectId, required: true },
	key: { type: String, required: true },
	externalId: { type: String, required: true },
	sha256: { type: String, required: true },
	status: { type: String, enum: ["uploading", "ready", "deleted"], default: "uploading" },
	fileName: { type: String, required: true, maxlength: 120 },
	contentType: { type: String, required: true },
	bytes: { type: Number, required: true, min: 1, max: 5242880 },
	publicAt: { type: Date },
	publicationConsentAt: { type: Date },
	publicBy: { type: String },
}, { timestamps: true });
schema.plugin(accountScoped);
schema.index({ accountId: 1, bookingId: 1, externalId: 1 }, { unique: true });
schema.index({ accountId: 1, bookingId: 1, createdAt: 1, _id: 1 });
export default mongoose.models.SponsorshipAsset || mongoose.model("SponsorshipAsset", schema);
