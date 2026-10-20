import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

// A contact seen inside the segment an automation starts from when it leaves it: the next look at the segment starts the
// automation for every contact here that no longer matches (lib/automations.js).
const automationWatchSchema = new mongoose.Schema({
	automationId: { type: mongoose.Schema.Types.ObjectId, ref: "Automation", required: true },
	contactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact", required: true },
});

automationWatchSchema.plugin(accountScoped);
automationWatchSchema.index({ automationId: 1, contactId: 1 }, { unique: true });

export default mongoose.models.AutomationWatch || mongoose.model("AutomationWatch", automationWatchSchema);
