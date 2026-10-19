import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";

const newsletterSchema = new mongoose.Schema(
	{
		name: { type: String, required: true, trim: true },
		// Unique across accounts: the archive lives at /archive/<slug>.
		slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
		imageUrl: { type: String, trim: true },
		fromName: { type: String, trim: true },
		fromEmail: { type: String, required: true, lowercase: true, trim: true },
		replyTo: { type: String, lowercase: true, trim: true },
		// Without one, emails print the server's default (lib/postal-address.js), unless the owner saved it empty.
		postalAddress: { type: String, trim: true },
		postalAddressCleared: { type: Boolean },
		archiveEnabled: { type: Boolean, default: false },
		// The account's verified archive subdomain (lib/domains.js syncArchiveHosts). Without one, the
		// archive and the links in its emails use <slug>.<shared domain>.
		archiveHost: { type: String, lowercase: true, trim: true },
		// The shared address's sending domain, <slug>.<shared domain>, in the account's tenant at the email
		// provider, with the DNS records FlockStack published for it on the shared domain (lib/shared-sender.js).
		sharedSender: {
			domain: { type: String, lowercase: true, trim: true },
			provider: { type: String },
			providerDomainId: { type: String },
			verified: { type: Boolean },
			dnsRecordIds: { type: [String], default: undefined },
			// Where those records are (lib/shared-dns.js): "cloudflare", or the DNS helper when unset.
			dnsDriver: { type: String },
			createdAt: { type: Date },
			checkedAt: { type: Date },
			verifiedAt: { type: Date },
		},
		description: { type: String, trim: true },
		// Buttons and links in the editor's blocks (lib/editor-blocks.js), as #rrggbb. Without one, ink.
		accentColor: { type: String, trim: true, lowercase: true },
		socialLinks: [{ type: String, trim: true }],
		// The archive's author page; the author's name is fromName.
		author: {
			bio: { type: String, trim: true },
			imageUrl: { type: String, trim: true },
		},
		// New signups get an email with a link and only join once they click it (confirmed opt-in).
		requireConfirmation: { type: Boolean, default: false },
		// Checked when an issue is sent (lib/cleanup.js). Empty numbers use the newsletter's defaults.
		cleanup: {
			enabled: { type: Boolean, default: false },
			issues: { type: Number, min: 1 },
			days: { type: Number, min: 1 },
		},
		welcome: {
			enabled: { type: Boolean, default: false },
			subject: { type: String, trim: true },
			previewText: { type: String, trim: true },
			markdown: { type: String },
		},
		// The referral program (lib/referrals.js). Rewards unlock at a number of referrals; each is a title and a link and/or
		// text, shown on the subscriber's referral page and sent in an email. id: stable, so editing a reward keeps its unlocks.
		referral: {
			enabled: { type: Boolean, default: false },
			rewards: [
				{
					_id: false,
					id: { type: String },
					referrals: { type: Number },
					title: { type: String, trim: true },
					url: { type: String, trim: true },
					text: { type: String, trim: true },
				},
			],
		},
		// Recommendations between newsletters (lib/recommendations.js). allowIncoming: other newsletters may recommend this one, on
		// unless its owner turns it off. listed: shown in the app's /recommendations directory, off unless its owner turns it on.
		recommendations: {
			allowIncoming: { type: Boolean, default: true },
			listed: { type: Boolean, default: false },
		},
		// Comments on the web issues (lib/comment-rules.js). who: everyone subscribed or paid subscribers only. moderation:
		// none, hold comments with links, or hold every comment for the owner's review. digestSentAt: the owner's last digest
		// of new comments (lib/comment-notify.js), at most one an hour.
		comments: {
			enabled: { type: Boolean, default: false },
			who: { type: String, enum: ["everyone", "paid"] },
			moderation: { type: String, enum: ["none", "hold_links", "hold_all"] },
			notifyOwner: { type: Boolean },
			digestSentAt: { type: Date },
		},
		// The paid tier (lib/payments/subscriptions.js): readers subscribe through Stripe Checkout on the creator's own Stripe
		// account. Prices are in cents of `currency`; a price of 0 means that interval isn't offered. Set by set_paid_tier,
		// never by the settings form.
		paidTier: {
			enabled: { type: Boolean, default: false },
			currency: { type: String, lowercase: true, trim: true },
			monthlyCents: { type: Number, min: 0 },
			yearlyCents: { type: Number, min: 0 },
			trialDays: { type: Number, min: 0 },
			pitch: { type: String, trim: true },
		},
		// The newsletter's own confirmation email; the built-in one goes out until it has one.
		confirmation: {
			subject: { type: String, trim: true },
			previewText: { type: String, trim: true },
			markdown: { type: String },
		},
	},
	{ timestamps: true }
);

newsletterSchema.plugin(accountScoped);
newsletterSchema.index({ accountId: 1, createdAt: 1 });
// The directory of newsletters that take recommendations lists only these.
newsletterSchema.index({ "recommendations.listed": 1 });
newsletterSchema.index({ archiveHost: 1 }, { unique: true, partialFilterExpression: { archiveHost: { $type: "string" } } });

export default mongoose.models.Newsletter || mongoose.model("Newsletter", newsletterSchema);
