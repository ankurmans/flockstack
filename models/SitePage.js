import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";
import { PAGE_STATUSES } from "../lib/site-page-rules.js";

// A page of a newsletter's website that isn't an issue (About, Sponsor, Contact): written in the same editor, published
// at /p/<slug> on the newsletter's host, linked from the navigation (Newsletter.navigation).
const sitePageSchema = new mongoose.Schema(
	{
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		title: { type: String, required: true, trim: true },
		// Shares /p/ with the issues' slugs, so a newsletter's pages and issues never use the same one (lib/archive-slugs.js, lib/actions/website.js).
		slug: { type: String, required: true, lowercase: true, trim: true },
		// An HTML fragment from the editor, cleaned when it is shown (lib/site-page-rules.js renderPageBody).
		html: { type: String, default: "" },
		// Search results and link previews; the page's first words otherwise.
		description: { type: String, trim: true },
		status: { type: String, enum: PAGE_STATUSES, default: "draft" },
		publishedAt: { type: Date },
	},
	{ timestamps: true }
);

sitePageSchema.plugin(accountScoped);
sitePageSchema.index({ newsletterId: 1, slug: 1 }, { unique: true });
sitePageSchema.index({ newsletterId: 1, status: 1, createdAt: 1 });

export default mongoose.models.SitePage || mongoose.model("SitePage", sitePageSchema);
