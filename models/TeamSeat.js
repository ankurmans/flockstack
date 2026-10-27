import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";
const schema = new mongoose.Schema({
	email: { type: String, required: true },
	userId: String,
	role: { type: String, enum: ["admin", "editor", "viewer"], required: true },
	status: { type: String, enum: ["invited", "active", "revoked"], default: "invited" },
	invitedAt: Date,
	acceptedAt: Date,
}, { timestamps: true });
schema.plugin(accountScoped);
schema.index({ accountId: 1, email: 1 }, { unique: true });
schema.index({ userId: 1, status: 1 });
schema.index({ email: 1, status: 1 });
export default mongoose.models.TeamSeat || mongoose.model("TeamSeat", schema);
