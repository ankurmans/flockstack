import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";
import { CUSTOM_FIELD_TYPES } from "../lib/custom-fields-rules.js";

export { CUSTOM_FIELD_TYPES };

// A value every contact of a newsletter can have, set from the dashboard, imports, signups and the API
// (lib/custom-fields.js). key is what merge tags and segments name it by: {{first_name}}.
const customFieldSchema = new mongoose.Schema(
	{
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		key: { type: String, required: true, trim: true },
		label: { type: String, required: true, trim: true },
		type: { type: String, enum: CUSTOM_FIELD_TYPES, required: true },
		// A list field's choices, and whether a contact can pick more than one.
		options: { type: [String], default: undefined },
		multiple: { type: Boolean },
		// Asked for on the newsletter's own signup form.
		onSignupForm: { type: Boolean, default: false },
		// Readers can change their own value on the preference center (lib/preferences.js).
		readerEditable: { type: Boolean },
	},
	{ timestamps: true }
);

customFieldSchema.plugin(accountScoped);
customFieldSchema.index({ newsletterId: 1, key: 1 }, { unique: true });

export default mongoose.models.CustomField || mongoose.model("CustomField", customFieldSchema);
