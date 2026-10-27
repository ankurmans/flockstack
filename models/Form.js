import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

// A signup form for other sites (lib/forms.js): a hosted page on the newsletter's host, framed by a one-line script, or
// posted to as plain HTML. Contacts it brings get source "form:<id>". views and signups are the running totals;
// FormDay has them by day.
const formSchema = new mongoose.Schema(
	{
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		externalId: { type: String, trim: true },
		name: { type: String, required: true, trim: true },
		buttonText: { type: String, trim: true },
		// The keys of the custom fields it asks for after the email; without any, only the email.
		fields: { type: [String], default: undefined },
		// #rrggbb, each optional: the newsletter's accent and plain text on a transparent page by default.
		colors: {
			button: { type: String, lowercase: true, trim: true },
			buttonText: { type: String, lowercase: true, trim: true },
			background: { type: String, lowercase: true, trim: true },
			text: { type: String, lowercase: true, trim: true },
		},
		successMessage: { type: String, trim: true },
		redirectUrl: { type: String, trim: true },
		flow: { type: mongoose.Schema.Types.Mixed },
		views: { type: Number, default: 0 },
		signups: { type: Number, default: 0 },
	},
	{ timestamps: true }
);

formSchema.plugin(accountScoped);
formSchema.index({ newsletterId: 1, createdAt: -1 });

formSchema.index({ accountId: 1, externalId: 1 }, { unique: true, partialFilterExpression: { externalId: { $type: "string" } } });

export default mongoose.models.Form || mongoose.model("Form", formSchema);
