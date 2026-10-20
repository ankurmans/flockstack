import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

// A piece of content written once and inserted into issues from the editor's / menu (lib/templates.js): a sign-off, a
// sponsor's blurb, a call to action. html: a rich fragment, cleaned when it is saved.
const snippetSchema = new mongoose.Schema(
	{
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		name: { type: String, required: true, trim: true },
		html: { type: String, required: true },
	},
	{ timestamps: true }
);

snippetSchema.plugin(accountScoped);
snippetSchema.index({ newsletterId: 1, name: 1 });

export default mongoose.models.Snippet || mongoose.model("Snippet", snippetSchema);
