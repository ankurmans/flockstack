import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";
import { FONT_PAIR_IDS, THEME_IDS } from "../lib/brand.js";
import { NAV_KINDS } from "../lib/site-navigation.js";

const newsletterSchema = new mongoose.Schema(
	{
		externalId: { type: String, trim: true },
		language: { type: String, enum: ["en", "es", "fr", "de", "it", "pt"], default: "en" },
		replyInbox: { type: Boolean, default: false },
		agentBrief: String,
		meteredReadsPerMonth: { type: Number, default: 0 },
		mailingListsRevision: { type: Number, default: 0 },
		mailingLists: { type: [{ id: String, name: String, description: String, archived: Boolean }], default: undefined },
		perksRevision: { type: Number, default: 0 },
		perks: { type: [{ id: String, title: String, description: String, url: String, code: String, productId: String, tierId: String, archived: Boolean }], default: undefined },
		authorsRevision: { type: Number, default: 0 },
		authors: { type: [{ id: String, slug: String, name: String, bio: String, imageUrl: String, archived: Boolean }], default: undefined },
		readerTranslations: { type: Boolean, default: false },
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
		signupFlowFormId: { type: mongoose.Schema.Types.ObjectId, ref: "Form" },
		// "Ask me before an agent sends": what an API key or a connected app does in the SEND and DESTRUCTIVE classes
		// waits for the owner's approval, whatever the key's level (lib/agent-guard.js). Dashboard only (set_agent_approval).
		agentApproval: { type: Boolean },
		sendingBrake: { at: Date, reason: String, metric: String, revision: String },
		spreadUntil: { type: Date },
		senderChangedAt: { type: Date },
		// The account's verified archive subdomain (lib/domains.js syncArchiveHosts). Without one, the
		// archive and the links in its emails use <slug>.<shared domain>.
		archiveHost: { type: String, lowercase: true, trim: true },
		// The website at a path of the owner's own site, which forwards it here with the token (lib/mount-rules.js, lib/mounts.js).
		// Only its SHA-256 is kept; the previous one keeps working until previousUntil. The pages move there once verifiedAt is set.
		// Never with an archiveHost.
		mount: {
			url: { type: String, trim: true },
			tokenHash: { type: String },
			previousTokenHash: { type: String },
			previousUntil: { type: Date },
			verifiedAt: { type: Date },
		},
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
		// The rest of the brand (lib/brand.js): the website's theme, a pair of fonts for the site and the email, a wide
		// image above the issue in the email and on the website, and the logo and name above the issue in the email.
		// The logo itself is imageUrl.
		brand: {
			theme: { type: String, enum: THEME_IDS },
			fontPair: { type: String, enum: FONT_PAIR_IDS },
			headerUrl: { type: String, trim: true },
			emailLogo: { type: Boolean },
		},
		// The website's navigation bar, in order (lib/site-navigation.js). id: stable, so reordering keeps an item's identity.
		navigation: [
			{
				_id: false,
				id: { type: String },
				kind: { type: String, enum: NAV_KINDS },
				label: { type: String, trim: true },
				pageId: { type: String },
				tag: { type: String, trim: true },
				url: { type: String, trim: true },
			},
		],
		// Every email's footer links to the reader's preference center (lib/preferences.js).
		preferencesLink: { type: Boolean },
		// Issues' outgoing links get utm_source (the newsletter), utm_medium=email and utm_campaign (the issue) added
		// (lib/link-utm.js), unless a link has UTM parameters of its own.
		utmLinks: { type: Boolean },
		// Extra headers on the newsletter's emails (lib/custom-headers.js): an allowlist, never the unsubscribe or signing ones.
		customHeaders: [{ _id: false, name: { type: String, trim: true }, value: { type: String, trim: true } }],
		// Share buttons (X, LinkedIn, Facebook, email) beside the read online link in the email's header (lib/share-links.js). An
		// issue can say otherwise (Campaign.shareButtons).
		shareButtons: { type: Boolean },
		// How long the dashboard holds a send so it can be undone: 0, 10, 30 or 60 seconds (lib/send-hold-rules.js). Unset: 30.
		sendUndoSeconds: { type: Number },
		// The website's signup pop-up and the gate (lib/popup-rules.js): when it opens, how long closing it snoozes it, where it
		// shows, and whether older issues show only their beginning to readers who haven't subscribed. Unsaved: the defaults.
		popup: {
			enabled: { type: Boolean },
			trigger: { type: String, enum: ["scroll", "time", "exit"] },
			seconds: { type: Number },
			scrollPercent: { type: Number },
			frequencyDays: { type: Number },
			pages: { type: String, enum: ["issues", "home", "all"] },
			gate: {
				enabled: { type: Boolean },
				previewPercent: { type: Number },
				freeLatest: { type: Number },
			},
		},
		// The key id in the newsletter's Magic Link (lib/magic-links.js), 1 until it is retired: a link of an earlier id stops working.
		magicKeyId: { type: Number, min: 1 },
		// The newsletter's own structured data for search engines: compact JSON of one block or a list (lib/seo-rules.js
		// checkJsonLd), added to the archive's home page and every issue's page.
		jsonLd: { type: String },
		// What a new issue starts with (lib/templates.js): rich HTML above and below where the writer starts. The accent
		// above is the third part of a newsletter's style.
		defaultStyle: {
			header: { type: String },
			footer: { type: String },
		},
		socialLinks: [{ type: String, trim: true }],
		// The link-in-bio page at /links on the newsletter's host (lib/link-page.js): a title, a short bio and the links the
		// writer lists, in order.
		linkPage: {
			enabled: { type: Boolean, default: false },
			title: { type: String, trim: true },
			bio: { type: String, trim: true },
			links: [
				{
					_id: false,
					label: { type: String, trim: true },
					url: { type: String, trim: true },
				},
			],
		},
		// The archive's author page; the author's name is fromName.
		author: {
			bio: { type: String, trim: true },
			imageUrl: { type: String, trim: true },
		},
		// New signups get an email with a link and only join once they click it (confirmed opt-in).
		requireConfirmation: { type: Boolean, default: false },
		// New signups wait as held contacts until the owner approves them (lib/signup-approval.js), after their confirmation
		// where one is asked.
		signupApproval: { type: Boolean, default: false },
		// Paid subscribers may make a link to a single paid issue (lib/gift-links.js): { enabled, perReaderPerMonth, opensPerLink, days }.
		giftLinks: { type: mongoose.Schema.Types.Mixed },
		// The website shows no issue to anyone but a signed-in active subscriber (lib/archive-private.js): no lists, feed,
		// sitemap or search, and every page asks to join or sign in.
		privateArchive: { type: Boolean, default: false },
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
					kind: { type: String, enum: ["message", "code", "gift"] },
					tierId: { type: String },
					months: { type: Number },
				},
			],
		},
		// Recommendations between newsletters (lib/recommendations.js). allowIncoming: other newsletters may recommend this one, on
		// unless its owner turns it off. listed: shown in the app's /recommendations directory, off unless its owner turns it on.
		creatorMatch: {
			enabled: { type: Boolean },
			topics: [{ type: String }],
			emailNotifications: { type: Boolean },
		},
		recommendations: {
			allowIncoming: { type: Boolean, default: true },
			listed: { type: Boolean, default: false },
		},
		// Comments on the web issues (lib/comment-rules.js). who: everyone subscribed or paid subscribers only. moderation:
		// none, hold comments with links, or hold every comment for the owner's review. digestSentAt: the owner's last digest
		// of new comments (lib/comment-notify.js), at most one an hour.
		groupSubscriptions: { enabled: { type: Boolean, default: false } },
		sponsorships: { enabled: { type: Boolean, default: false } },
		readerRetention: { pauseEnabled: { type: Boolean, default: false }, surveyEnabled: { type: Boolean, default: false }, saveOfferId: { type: mongoose.Schema.Types.ObjectId } },
		hasGroupSubscriptions: { type: Boolean, default: false },
		replyRules: {
			enabled: { type: Boolean, default: false },
			rules: [{ id: { type: String }, text: { type: String } }],
			learnFromHides: { type: Boolean, default: false },
			revision: { type: String },
			consentedAt: { type: Date },
		},
		comments: {
			enabled: { type: Boolean, default: false },
			who: { type: String, enum: ["everyone", "paid"] },
			moderation: { type: String, enum: ["none", "hold_links", "hold_all"] },
			notifyOwner: { type: Boolean },
			digestSentAt: { type: Date },
		},
		// Audio versions of issues (lib/audio.js). voiceId: the default voice, one of the owner's curated ones. podcast: the public
		// podcast feed of the issues that have audio (lib/audio-feed.js), off until its owner turns it on; ownerEmail is
		// printed in the feed, so it is optional.
		audio: {
			voiceId: { type: String, trim: true },
			podcast: {
				enabled: { type: Boolean, default: false },
				category: { type: String, trim: true },
				explicit: { type: Boolean, default: false },
				ownerEmail: { type: String, trim: true, lowercase: true },
			},
		},
		// The paid tier (lib/payments/subscriptions.js): readers subscribe through Stripe Checkout on the creator's own Stripe
		// account. The newsletter-wide settings are here; the tiers themselves are in paidTiers. monthlyCents and yearlyCents
		// are the prices of a newsletter from before tiers (lib/tier-rules.js shows them as its one tier) and follow the
		// lowest tier once it has tiers. Set by set_paid_tier, never by the settings form.
		paidTier: {
			enabled: { type: Boolean, default: false },
			currency: { type: String, lowercase: true, trim: true },
			monthlyCents: { type: Number, min: 0 },
			yearlyCents: { type: Number, min: 0 },
			trialDays: { type: Number, min: 0 },
			// A trial asks for no card when Stripe allows it; the card is asked for when the trial ends.
			trialNoCard: { type: Boolean },
			pitch: { type: String, trim: true },
			// The supporters list on the subscribe page: founding members who gave a name for it (lib/supporters.js).
			supportersPublic: { type: Boolean },
			// Pledges (lib/pledges.js): readers commit to a price without being charged. noticeDays: how long before
			// the first charge each pledger is told.
			pledges: {
				enabled: { type: Boolean },
				noticeDays: { type: Number, min: 1 },
			},
			// Gift subscriptions (lib/gifts.js).
			gifts: {
				enabled: { type: Boolean },
			},
			// The launch offer shown on the subscribe page and the website (lib/offers.js).
			banner: {
				enabled: { type: Boolean },
				text: { type: String, trim: true },
				offerId: { type: String },
			},
		},
		// Up to 3 paid tiers, lowest first (lib/tier-rules.js). Mixed: each tier is { id, name, description, benefits, prices,
		// pwyw, founding, archived, stripe }, and stripe holds the Product and Price ids made on the creator's account.
		paidTiers: { type: [mongoose.Schema.Types.Mixed], default: undefined },
		// Confirmed opt-in's extras: one reminder to signups still unconfirmed delayHours after signing up
		// (lib/confirmation-reminders.js), and the page a reader lands on once confirmed, instead of FlockStack's own.
		confirmationReminder: {
			enabled: { type: Boolean, default: false },
			delayHours: { type: Number, min: 1 },
		},
		confirmedRedirectUrl: { type: String, trim: true },
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
// The hourly reminders to confirm read only the newsletters that send them.
newsletterSchema.index({ "confirmationReminder.enabled": 1 });
// The directory of newsletters that take recommendations lists only these.
newsletterSchema.index({ "recommendations.listed": 1 });
newsletterSchema.index({ "creatorMatch.enabled": 1, "recommendations.listed": 1, archiveEnabled: 1, _id: 1 });
newsletterSchema.index({ archiveHost: 1 }, { unique: true, partialFilterExpression: { archiveHost: { $type: "string" } } });

newsletterSchema.index({ accountId: 1, externalId: 1 }, { unique: true, partialFilterExpression: { externalId: { $type: "string" } } });

export default mongoose.models.Newsletter || mongoose.model("Newsletter", newsletterSchema);
