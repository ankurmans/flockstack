import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

// One submission of a survey: answers by question ID (lib/survey-rules.js), from a subscriber through their signed link
// (contactId: one each, replaced when they answer again) or from a reader without one. source: the survey's page, the
// step after signing up, or the unsubscribe page.
const surveyResponseSchema = new mongoose.Schema(
	{
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		surveyId: { type: mongoose.Schema.Types.ObjectId, ref: "Survey", required: true },
		contactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact" },
		source: { type: String, enum: ["page", "signup", "unsubscribe"], default: "page" },
		answers: { type: mongoose.Schema.Types.Mixed },
	},
	{ timestamps: true }
);

surveyResponseSchema.plugin(accountScoped);
surveyResponseSchema.index({ surveyId: 1, createdAt: -1, _id: -1 });
surveyResponseSchema.index({ surveyId: 1, contactId: 1 }, { unique: true, partialFilterExpression: { contactId: { $exists: true } } });

export default mongoose.models.SurveyResponse || mongoose.model("SurveyResponse", surveyResponseSchema);
