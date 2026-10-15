import mongoose from "mongoose";
import { accountScoped } from "../lib/account-scope.js";

// Uploaded images, on S3 behind the CDN or, for older ones and servers without S3, on Vercel Blob. Sent emails
// point at the URL forever, so the file is never moved. pathname is the S3 key or the Blob pathname.
const uploadSchema = new mongoose.Schema(
	{
		url: { type: String, required: true },
		pathname: { type: String, required: true },
		contentType: { type: String, required: true },
		bytes: { type: Number, required: true },
	},
	{ timestamps: true }
);

uploadSchema.plugin(accountScoped);
uploadSchema.index({ accountId: 1, createdAt: -1 });

export default mongoose.models.Upload || mongoose.model("Upload", uploadSchema);
