import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

// A customer's own sending domain. Unique across accounts: a domain belongs to the first account that adds it.
const domainSchema = new mongoose.Schema(
	{
		domain: { type: String, required: true, unique: true, lowercase: true, trim: true },
		mailFromDomain: { type: String, required: true, lowercase: true, trim: true },
		// Archive, tracked links and unsubscribe links live here once it points at FlockStack.
		archiveHost: { type: String, required: true, unique: true, lowercase: true, trim: true },
		// The email provider it was added at (lib/email-provider), and its id there. Domains from before the
		// provider switch are SES's.
		provider: { type: String },
		providerDomainId: { type: String },
		// As the provider last reported them (lib/domains.js checkDomain).
		verified: { type: Boolean, default: false },
		dkimStatus: { type: String, default: "PENDING" },
		mailFromStatus: { type: String, default: "PENDING" },
		archiveHostVerified: { type: Boolean, default: false },
		// FlockStack Cloud on Cloudflare: the archive subdomain as a Cloudflare for SaaS custom hostname, with the Worker
		// route that serves it, as the last check found them (lib/custom-hostnames.js).
		customHostname: {
			id: { type: String },
			routeId: { type: String },
			worker: { type: String },
			status: { type: String },
			sslStatus: { type: String },
			state: { type: String },
			records: [{ _id: false, type: { type: String }, name: String, value: String }],
			errors: { type: [String], default: undefined },
			checkedAt: { type: Date },
		},
		records: [{ _id: false, purpose: String, type: { type: String }, name: String, value: String }],
		// The DMARC record found on the domain, or on the closest parent with one (lib/dmarc-rules.js).
		dmarc: { status: { type: String }, host: { type: String } },
		// The last check, which PostShiba's verification budget counts from, and the Domains page's last read, which doesn't.
		checkedAt: { type: Date },
		readAt: { type: Date },
		verifiedAt: { type: Date },
	},
	{ timestamps: true }
);

domainSchema.plugin(accountScoped);
domainSchema.index({ accountId: 1, createdAt: 1 });

export default mongoose.models.Domain || mongoose.model("Domain", domainSchema);
