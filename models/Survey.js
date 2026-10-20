import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";
import { QUESTION_TYPES } from "../lib/survey-rules.js";

// Questions a newsletter asks its readers on a page of its website (/survey), after they sign up or when they leave
// (placement), with each answer saved to a custom field when the question names one (lib/surveys.js). A question's id
// stays the same across edits, so its answers stay with it.
const surveySchema = new mongoose.Schema(
	{
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		title: { type: String, required: true, trim: true },
		intro: { type: String, trim: true },
		questions: [
			{
				_id: false,
				id: { type: String },
				type: { type: String, enum: QUESTION_TYPES },
				label: { type: String, trim: true },
				options: { type: [String], default: undefined },
				required: { type: Boolean },
				fieldKey: { type: String, trim: true },
			},
		],
		// Shown to new subscribers once they sign up on the website, and to subscribers who just unsubscribed. One survey of a
		// newsletter has each.
		placement: {
			afterSignup: { type: Boolean },
			onUnsubscribe: { type: Boolean },
		},
		thankYou: { type: String, trim: true },
		closed: { type: Boolean, default: false },
	},
	{ timestamps: true }
);

surveySchema.plugin(accountScoped);
surveySchema.index({ newsletterId: 1, createdAt: -1 });

export default mongoose.models.Survey || mongoose.model("Survey", surveySchema);
