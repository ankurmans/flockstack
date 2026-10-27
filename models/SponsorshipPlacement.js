import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

const schema = new mongoose.Schema({
	newsletterId: { type: mongoose.Schema.Types.ObjectId, required: true },
	name: { type: String, required: true, trim: true, maxlength: 80 },
	description: { type: String, trim: true, maxlength: 1000 },
	amountMinor: { type: Number, required: true, min: 50, max: 100000000 },
	currency: { type: String, required: true, trim: true, lowercase: true },
	archived: { type: Boolean, default: false },
}, { timestamps: true });
schema.plugin(accountScoped);
schema.index({ accountId: 1, newsletterId: 1, archived: 1, createdAt: 1, _id: 1 });
export default mongoose.models.SponsorshipPlacement || mongoose.model("SponsorshipPlacement", schema);
