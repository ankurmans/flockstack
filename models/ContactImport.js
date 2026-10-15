import mongoose from "mongoose";
import { accountScoped } from "../lib/account-scope.js";

const counter = { type: Number, default: 0 };

// One CSV import (sent in chunks), with the customer's word that these people agreed to their emails.
const contactImportSchema = new mongoose.Schema(
	{
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		userId: { type: mongoose.Schema.Types.ObjectId },
		// The API key that gave the consent, for imports through the API or MCP.
		apiKeyId: { type: mongoose.Schema.Types.ObjectId },
		source: { type: String, default: "dashboard" },
		consent: { type: Boolean, required: true },
		consentText: { type: String, required: true },
		consentAt: { type: Date, required: true },
		rows: counter,
		created: counter,
		existing: counter,
		dropped: {
			invalid: counter,
			typo: counter,
			trap: counter,
			role: counter,
			disposable: counter,
			duplicate: counter,
			suppressed: counter,
			undeliverable: counter,
			noMail: counter,
		},
	},
	{ timestamps: true }
);

contactImportSchema.plugin(accountScoped);
contactImportSchema.index({ accountId: 1, createdAt: -1 });

export default mongoose.models.ContactImport || mongoose.model("ContactImport", contactImportSchema);
