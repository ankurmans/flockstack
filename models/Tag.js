import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";
import { TAG_COLORS } from "../lib/tag-colors.js";

// The tags a newsletter's contacts have had, so listing them doesn't read every contact. The contacts hold the tags
// themselves (Contact.tags); a tag stays here after its last contact loses it, until it's deleted.
const tagSchema = new mongoose.Schema(
	{
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		name: { type: String, required: true, trim: true },
		// Drawn on the tag wherever it shows (lib/tag-colors.js). Without one it is gray.
		color: { type: String, enum: TAG_COLORS },
	},
	{ timestamps: true }
);

tagSchema.plugin(accountScoped);
tagSchema.index({ newsletterId: 1, name: 1 }, { unique: true });

export default mongoose.models.Tag || mongoose.model("Tag", tagSchema);
