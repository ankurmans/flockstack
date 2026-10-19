import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

// Uploaded images, on S3 behind the CDN or, for older ones and servers without S3, on Vercel Blob. Sent emails
// point at the URL forever, so the file is never moved. pathname is the S3 key or the Blob pathname.
const uploadSchema = new mongoose.Schema(
	{
		url: { type: String, required: true },
		pathname: { type: String, required: true },
		contentType: { type: String, required: true },
		bytes: { type: Number, required: true },
		// Where a post import downloaded it from: the same picture in another post, or the same import run again, uses
		// this file instead of storing it twice.
		sourceUrl: { type: String },
	},
	{ timestamps: true }
);

uploadSchema.plugin(accountScoped);
uploadSchema.index({ accountId: 1, createdAt: -1 });
uploadSchema.index({ accountId: 1, sourceUrl: 1 }, { partialFilterExpression: { sourceUrl: { $type: "string" } } });

export default mongoose.models.Upload || mongoose.model("Upload", uploadSchema);
