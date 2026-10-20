import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

// One answer to a poll: a subscriber's from an email link (contactId), or a web reader's (voterKey, a keyed hash of
// their address that is never shown). One each per poll, changed when they vote again. comment: their answer to the
// poll's follow-up question.
const pollVoteSchema = new mongoose.Schema(
	{
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		pollId: { type: mongoose.Schema.Types.ObjectId, ref: "Poll", required: true },
		contactId: { type: mongoose.Schema.Types.ObjectId, ref: "Contact" },
		voterKey: { type: String },
		option: { type: Number, required: true },
		comment: { type: String, trim: true },
	},
	{ timestamps: true }
);

pollVoteSchema.plugin(accountScoped);
pollVoteSchema.index({ pollId: 1, contactId: 1 }, { unique: true, partialFilterExpression: { contactId: { $exists: true } } });
pollVoteSchema.index({ pollId: 1, voterKey: 1 }, { unique: true, partialFilterExpression: { voterKey: { $exists: true } } });
pollVoteSchema.index({ pollId: 1, option: 1 });

export default mongoose.models.PollVote || mongoose.model("PollVote", pollVoteSchema);
