import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

const schema = new mongoose.Schema({
	newsletterId: { type: mongoose.Schema.Types.ObjectId, required: true },
	placementId: { type: mongoose.Schema.Types.ObjectId, required: true },
	day: { type: String, required: true, maxlength: 10 },
	timeZone: { type: String, required: true, maxlength: 80 },
	placementName: { type: String, required: true },
	amountMinor: { type: Number, required: true, min: 50, max: 100000000 },
	currency: { type: String, required: true, lowercase: true },
	status: { type: String, enum: ["open", "reserved", "closed"], default: "open" },
	bookingId: { type: mongoose.Schema.Types.ObjectId },
	revision: { type: Number, default: 0 },
}, { timestamps: true });
schema.plugin(accountScoped);
schema.index({ accountId: 1, newsletterId: 1, placementId: 1, day: 1 }, { unique: true });
schema.index({ accountId: 1, newsletterId: 1, status: 1, day: 1, _id: 1 });
export default mongoose.models.SponsorshipSlot || mongoose.model("SponsorshipSlot", schema);
