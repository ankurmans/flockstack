import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";
import { CONTACT_TIERS } from "../lib/tiers.js";

// pending: signed up to a newsletter that asks new subscribers to confirm, and hasn't yet.
export const CONTACT_STATUSES = ["active", "pending", "unsubscribed", "bounced", "complained", "dormant"];

const contactSchema = new mongoose.Schema(
	{
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		email: { type: String, required: true, lowercase: true, trim: true },
		status: { type: String, enum: CONTACT_STATUSES, default: "active" },
		source: { type: String, trim: true },
		// Two-letter country of the network they signed up from, Cloudflare's cf-ipcountry (lib/signup-country.js): segments
		// filter on it. Set once, at signup, and not on contacts that joined before it was kept.
		country: { type: String, trim: true },
		// Free-form labels, normalized by lib/tags.js. Filters on them run in SQL (lib/docdb/sql.js, arrays of scalars).
		tags: { type: [String], default: undefined },
		// The newsletter's custom fields by key (lib/custom-fields.js): text, a number, a date (YYYY-MM-DD), a date and time,
		// true or false, or a list field's option, or options as an array.
		fields: { type: mongoose.Schema.Types.Mixed, scalarMembers: true },
		// The answer this subscriber gave each poll from an email, by "p" and the poll's ID, so segments filter on it
		// (lib/polls.js keeps it in step with the vote).
		polls: { type: mongoose.Schema.Types.Mixed, scalarMembers: true },
		importId: { type: mongoose.Schema.Types.ObjectId, ref: "ContactImport" },
		// Added by hand on the dashboard: the user who said this person agreed to get the newsletter, and when.
		consent: {
			userId: { type: mongoose.Schema.Types.ObjectId },
			at: { type: Date },
		},
		// A reader of a newsletter with a paid tier is paid while Stripe says their subscription is active or in its trial
		// (lib/payments/subscriptions.js); paidUntil is the end of the period they paid for. A contact with no tier is free.
		tier: { type: String, enum: CONTACT_TIERS, default: "free" },
		paidUntil: { type: Date },
		paidSince: { type: Date },
		paidInterval: { type: String, enum: ["month", "quarter", "year", "lifetime"] },
		// The paid tier the contact holds (lib/tier-rules.js); a paid contact from before tiers has none and holds the first.
		paidTierId: { type: String },
		// Paid access given by hand or as a gift, apart from Stripe: { kind: comp or gift, tierId, until, at, note, giftId }.
		// Stripe's subscription wins while it is paid; the grant holds after it ends, until its end (lib/grants.js).
		grant: {
			kind: { type: String, enum: ["comp", "gift"] },
			tierId: { type: String },
			until: { type: Date },
			at: { type: Date },
			note: { type: String },
			giftId: { type: String },
		},
		// The offer a paid reader signed up with (lib/offers.js).
		offerId: { type: String },
		// The name a founding member asked to be listed under on the supporters list.
		supporterName: { type: String },
		stripeCustomerId: { type: String },
		stripeSubscriptionId: { type: String },
		// A lifetime tier's one payment, so a refund of it ends the access.
		lifetimePaymentIntentId: { type: String },
		// Stripe's status for the subscription: active, trialing, past_due, canceled…
		subscriptionStatus: { type: String },
		// Where the signup came from, set once when the contact is made (lib/attribution.js): a channel, the UTM parameters the
		// page was opened with, and the host of the page that linked to it.
		acquisition: {
			channel: { type: String },
			utm: {
				source: { type: String },
				medium: { type: String },
				campaign: { type: String },
				term: { type: String },
				content: { type: String },
			},
			referrer: { type: String },
		},
		subscribedAt: { type: Date, default: Date.now },
		confirmedAt: { type: Date },
		// The one reminder to confirm went out (lib/confirmation-reminders.js).
		confirmReminderAt: { type: Date },
		unsubscribedAt: { type: Date },
		lastSentAt: { type: Date },
		lastOpenAt: { type: Date },
		lastClickAt: { type: Date },
		// List cleanup (lib/cleanup.js): issues received since the last sign of life (open, click,
		// confirmation, signup, "keep sending it" click), when that was, and when the last-chance email went out.
		ignoredIssues: { type: Number },
		lastEngagedAt: { type: Date },
		lastChanceAt: { type: Date },
		// Bounced without a send of this account: a send skipped it, on the never-email list (lib/global-suppressions.js).
		undeliverableAt: { type: Date },
		stats: {
			sent: { type: Number, default: 0 },
			opens: { type: Number, default: 0 },
			clicks: { type: Number, default: 0 },
		},
		// The referral program (lib/referrals.js): referrals this contact brought in, once they confirmed, and who brought
		// this one in. signupIpHash: a keyed hash of the address they signed up from, to tell a household from a farm.
		referral: {
			count: { type: Number },
			referredBy: { type: mongoose.Schema.Types.ObjectId },
			referredAt: { type: Date },
		},
		signupIpHash: { type: String },
		// Comments on the newsletter's web issues (lib/comments.js). displayName is what other readers see, never the email;
		// it is set once, on the first comment (nameLocked). blocked turns commenting off for this reader, who stays
		// subscribed, with the reason the owner gave. repliesOff: no emails about replies. lastSignInT: the issue time of the
		// last one-time sign-in link used, so a link works once (lib/reader-links.js).
		community: {
			displayName: { type: String },
			nameLocked: { type: Boolean },
			blocked: { type: Boolean },
			blockedReason: { type: String },
			blockedAt: { type: Date },
			repliesOff: { type: Boolean },
			lastSignInT: { type: Number },
		},
		// From a CSV import: engagement on the previous platform, so sends reach the most engaged first.
		imported: {
			emailsReceived: { type: Number },
			openRate: { type: Number },
			clickRate: { type: Number },
		},
	},
	{ timestamps: true }
);

contactSchema.plugin(accountScoped);
contactSchema.index({ newsletterId: 1, email: 1 }, { unique: true });
contactSchema.index({ newsletterId: 1, status: 1, createdAt: -1 });
// Bounces and complaints change every contact with the address in the account.
contactSchema.index({ accountId: 1, email: 1 });
// The contacts list shows the newest subscribers first, with or without newsletter and status filters.
// It breaks ties by _id, which the index needs too: without it MongoDB sorts the whole list on every page.
contactSchema.index({ accountId: 1, subscribedAt: -1, _id: -1 });
contactSchema.index({ accountId: 1, status: 1, subscribedAt: -1, _id: -1 });
contactSchema.index({ newsletterId: 1, subscribedAt: -1, _id: -1 });
contactSchema.index({ newsletterId: 1, status: 1, subscribedAt: -1, _id: -1 });
// The growth report counts who left in a range of dates (lib/reports.js).
contactSchema.index({ newsletterId: 1, status: 1, unsubscribedAt: 1 });
// Stripe's subscription events find their contact by subscription or customer.
contactSchema.index({ stripeSubscriptionId: 1 }, { partialFilterExpression: { stripeSubscriptionId: { $type: "string" } } });
contactSchema.index({ newsletterId: 1, stripeCustomerId: 1 }, { partialFilterExpression: { stripeCustomerId: { $type: "string" } } });
// Counting and sending to a newsletter's paid readers.
contactSchema.index({ newsletterId: 1, tier: 1, status: 1 });
contactSchema.index({ newsletterId: 1, paidTierId: 1 }, { partialFilterExpression: { paidTierId: { $type: "string" } } });
// The hourly check for comps and gifts that ran out (lib/grant-access.js).
contactSchema.index({ "grant.until": 1 }, { partialFilterExpression: { "grant.until": { $exists: true } } });
// The list cleanup totals in newsletter settings.
contactSchema.index({ newsletterId: 1, lastChanceAt: 1 }, { partialFilterExpression: { lastChanceAt: { $exists: true } } });
// An admin taking an address off the never-email list finds the contacts it stopped, in every account.
contactSchema.index({ email: 1 }, { partialFilterExpression: { undeliverableAt: { $exists: true } } });

// The referral leaderboard.
contactSchema.index({ newsletterId: 1, "referral.count": -1, _id: 1 }, { partialFilterExpression: { "referral.count": { $exists: true } } });

export default mongoose.models.Contact || mongoose.model("Contact", contactSchema);
