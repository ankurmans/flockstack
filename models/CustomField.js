import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

export const CUSTOM_FIELD_TYPES = ["text", "number", "date"];

// A value every contact of a newsletter can have, set from the dashboard, imports, signups and the API
// (lib/custom-fields.js). key is what merge tags and segments name it by: {{first_name}}.
const customFieldSchema = new mongoose.Schema(
	{
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		key: { type: String, required: true, trim: true },
		label: { type: String, required: true, trim: true },
		type: { type: String, enum: CUSTOM_FIELD_TYPES, required: true },
		// Asked for on the newsletter's own signup form.
		onSignupForm: { type: Boolean, default: false },
	},
	{ timestamps: true }
);

customFieldSchema.plugin(accountScoped);
customFieldSchema.index({ newsletterId: 1, key: 1 }, { unique: true });

export default mongoose.models.CustomField || mongoose.model("CustomField", customFieldSchema);
