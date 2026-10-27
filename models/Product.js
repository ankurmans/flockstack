import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

// draft: being set up, not for sale. active: on the newsletter's shop. archived: off the shop and not for sale, but people
// who bought it keep their download links.
export const PRODUCT_STATUSES = ["draft", "active", "archived"];

const productSchema = new mongoose.Schema(
	{
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		title: { type: String, required: true, trim: true },
		// The product's page on the newsletter's site: /shop/<slug>.
		slug: { type: String, required: true, lowercase: true, trim: true },
		description: { type: String, trim: true, default: "" },
		priceCents: { type: Number, required: true, min: 0 },
		currency: { type: String, required: true, lowercase: true, trim: true, default: "usd" },
		status: { type: String, enum: PRODUCT_STATUSES, default: "draft" },
		imageUrl: { type: String, trim: true },
		// The file buyers download. It lives in a private R2 bucket (lib/private-files.js) and is only ever served through a
		// signed order link, or an entitled reader session for a perk, never from a public URL.
		file: {
			key: { type: String },
			name: { type: String },
			contentType: { type: String },
			bytes: { type: Number },
			uploadedAt: { type: Date },
		},
		archivedAt: { type: Date },
	},
	{ timestamps: true }
);

productSchema.plugin(accountScoped);
productSchema.index({ newsletterId: 1, slug: 1 }, { unique: true });
productSchema.index({ newsletterId: 1, status: 1, createdAt: -1 });
productSchema.index({ accountId: 1, createdAt: -1, _id: -1 });

export default mongoose.models.Product || mongoose.model("Product", productSchema);
