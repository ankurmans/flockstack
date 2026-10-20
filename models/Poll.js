import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

// A question with two to six answers, placed in an issue as the editor's poll block (lib/editor-blocks.js). The block
// carries a copy of the question and answers to show; this is what votes are checked against (lib/polls.js).
// fieldKey: a custom field set to the answer's label when a subscriber votes. tag: given for that answer, and taken
// back when the vote changes. followUp: a question the thank-you page asks, answered in free text.
const pollSchema = new mongoose.Schema(
	{
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		// The issue it was made in, if any.
		campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign" },
		question: { type: String, required: true, trim: true },
		options: [
			{
				_id: false,
				label: { type: String, trim: true },
				tag: { type: String, trim: true },
			},
		],
		fieldKey: { type: String, trim: true },
		showResults: { type: Boolean, default: true },
		followUp: { type: String, trim: true },
		closed: { type: Boolean, default: false },
	},
	{ timestamps: true }
);

pollSchema.plugin(accountScoped);
pollSchema.index({ newsletterId: 1, createdAt: -1 });
pollSchema.index({ campaignId: 1 }, { partialFilterExpression: { campaignId: { $exists: true } } });

export default mongoose.models.Poll || mongoose.model("Poll", pollSchema);
