import mongoose from "../lib/docdb/index.js";
import { INTERVALS, PLAN_IDS } from "../lib/plans.js";

export const ACCOUNT_STATUSES = ["active", "paused"];
export const BLOCK_SOURCES = ["admin", "rates", "campaign", "slice", "trap", "ses", "postshiba", "gmail"];

const watchIssue = {
	rate: { type: Number },
	limit: { type: Number },
	count: { type: Number },
	sent: { type: Number },
	detail: { type: String, trim: true },
	seenAt: { type: Date },
};

const accountSchema = new mongoose.Schema(
	{
		// The Better Auth user who signed up. One user per account at launch.
		ownerId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
		// Written by the Stripe or Polar webhook (lib/billing.js, lib/billing-polar.js) and the checkout return, never from
		// a form. Which provider bills is lib/billing-provider.js's choice; the other pair stays empty.
		plan: { type: String, enum: PLAN_IDS },
		interval: { type: String, enum: INTERVALS },
		stripeCustomerId: { type: String },
		stripeSubscriptionId: { type: String },
		polarCustomerId: { type: String },
		polarSubscriptionId: { type: String },
		subscriptionStatus: { type: String },
		currentPeriodStart: { type: Date },
		currentPeriodEnd: { type: Date },
		cancelAt: { type: Date },
		// Emails sent this month of the paid period (lib/usage-period.js): every kind counts. welcomePausedAt: when the
		// month's first welcome email was skipped for want of emails left, which told the owner; a new month clears it.
		usage: {
			emailsSent: { type: Number, default: 0 },
			periodStart: { type: Date },
			periodEnd: { type: Date },
			anchor: { type: Date },
			paidThrough: { type: Date },
			welcomePausedAt: { type: Date },
		},
		// "paused" is a blocked account (lib/account-blocks.js): it sends nothing, welcome and confirmation emails
		// included, and refuses every change but stopping things, until an admin unblocks it. pauseReason is what its
		// owner sees.
		status: { type: String, enum: ACCOUNT_STATUSES, default: "active" },
		pausedAt: { type: Date },
		pauseReason: { type: String, trim: true },
		// admin: by hand. rates: the 7-day check (lib/account-health.js). campaign: a send's own rates. slice: a first
		// send's slice (lib/first-send.js). trap: a bounce from a spam trap. ses, postshiba: the provider stopped the
		// account's tenant. gmail: Gmail's spam rate in Google Postmaster Tools (lib/postmaster.js).
		pausedBy: { type: String, enum: BLOCK_SOURCES },
		// The last time an admin unblocked it: Gmail's data on the days up to then doesn't block it again.
		unblockedAt: { type: Date },
		// The account's SES tenant and configuration set, created when its plan starts (lib/email-provider/ses.js).
		ses: {
			tenantName: { type: String },
			tenantArn: { type: String },
			configurationSet: { type: String },
			provisionedAt: { type: Date },
			// Last status SES reported through EventBridge: ENABLED, DISABLED or REINSTATED.
			tenantStatus: { type: String },
			tenantStatusAt: { type: Date },
			lastFinding: { type: String },
			// The account's own standard SES pool and the leased IP in it (lib/ip-assignment.js), while it has one. A pool without
			// an address is a managed pool from before standard IPs: the admin page deletes it.
			dedicatedPool: { type: String },
			dedicatedPoolAt: { type: Date },
			dedicatedIpAddress: { type: String },
			// The second configuration set, pointed at that pool: SES has no pool per message, so each email picks one of the two.
			// Set once the IP is in the pool, and unset first when it leaves, which is what routes mail back to shared IPs.
			dedicatedConfigurationSet: { type: String },
			// The IP's warm-up (lib/ip-warmup-rules.js): the share of the account's email that goes through the pool, in percent,
			// which the hourly job raises a day at a time while bounces and complaints stay low.
			ipWarmup: {
				startedAt: { type: Date },
				day: { type: Number },
				share: { type: Number },
				advancedAt: { type: Date },
				completedAt: { type: Date },
				holds: { type: Number },
				heldAt: { type: Date },
				holdReason: { type: String },
			},
		},
		// The account's PostShiba tenant (slug mc-<accountId>) and SMTP credentials, created when its plan starts
		// (lib/email-provider/postshiba.js).
		postshiba: {
			tenantId: { type: String },
			tenantSlug: { type: String },
			// active, suspended (with the account's pause) or operator_hold (PostShiba's abuse team paused it).
			tenantStatus: { type: String },
			tenantStatusAt: { type: Date },
			provisionedAt: { type: Date },
			// Campaigns go out over HTTP inject with this login. PostShiba shows the password once; it's stored
			// AES-256-GCM encrypted (lib/credentials.js) and only read where a send needs it.
			bulkCredential: {
				credentialId: { type: String },
				username: { type: String },
				password: { type: String, select: false },
				clusterId: { type: String },
			},
			// POST /sends needs a live credential for the tenant on the transactional cluster, not its password.
			transactionalCredential: {
				credentialId: { type: String },
				clusterId: { type: String },
			},
		},
		// Early warnings before an automatic block (lib/account-watch.js), by issue: what was measured and when it was last
		// seen. The dashboard shows the ones seen within WATCH.periodDays (lib/config.js); a check back under the level
		// clears its issue.
		watch: {
			bounces: watchIssue,
			complaints: watchIssue,
			gmail: watchIssue,
			provider: watchIssue,
		},
		// The last account-level check on recent sends.
		health: {
			checkedAt: { type: Date },
			sent: { type: Number },
			delivered: { type: Number },
			bounceRate: { type: Number },
			complaintRate: { type: Number },
		},
		// The end of the account's 30-day warm-up, set by its first campaign: until then, a send can grow less over what
		// the account proved before it's paced (lib/send-spread.js). An admin can end it early or start it again.
		spreadUntil: { type: Date },
		// What the account answered at /welcome (lib/onboarding.js): listSize picks the plan the paywall shows first.
		// The overview's get-started list (lib/get-started.js) stays hidden once it's dismissed or finished.
		onboarding: {
			listSize: { type: String, trim: true },
			listSource: { type: String, trim: true },
			completedAt: { type: Date },
			checklistDismissedAt: { type: Date },
			checklistFinishedAt: { type: Date },
		},
		// Extra emails past the plan's (lib/plans.js, lib/extra-emails.js). billable: the Polar subscription carries the extra
		// emails price, as the webhook last read it. limit: the owner's monthly limit on them; unset is the plan's emails.
		extraEmails: {
			billable: { type: Boolean },
			limit: { type: Number, min: 0 },
		},
		// The dedicated IP add-on, a Polar subscription of its own next to the plan's (lib/dedicated-ip.js), as the webhook
		// last read it. turnedOnAt: when the add-on turned the account's dedicated IP on, so its end turns off only that,
		// never one an admin gave by hand.
		dedicatedIp: {
			polarSubscriptionId: { type: String },
			status: { type: String },
			plan: { type: String, enum: PLAN_IDS },
			interval: { type: String, enum: INTERVALS },
			currentPeriodEnd: { type: Date },
			cancelAt: { type: Date },
			turnedOnAt: { type: Date },
			// When the add-on was paid with no free IP in the inventory (lib/ip-inventory.js): it turns on by itself once one is added.
			waitingAt: { type: Date },
			error: { type: String, trim: true },
		},
		// A paid plan's choice to carry the "Sent with FlockStack" link (lib/free-plan.js); unset is off. The Free plan always
		// carries it, whatever this says.
		sentWithLink: { type: Boolean },
		// Set by an admin; they replace the plan's numbers.
		limitOverrides: {
			emailsPerMonth: { type: Number, min: 0 },
			subscribers: { type: Number, min: 0 },
			audioCharactersPerMonth: { type: Number, min: 0 },
		},
		// A free plan an admin gave from /admin (lib/billing.js grantFreePlan): the plan's limits without Stripe, from
		// grantedAt until `until`, or with no end. Ending it sets `until`. by: the admin's email.
		comp: {
			plan: { type: String, enum: PLAN_IDS },
			grantedAt: { type: Date },
			until: { type: Date },
			by: { type: String, trim: true },
		},
		// Where the creator's sales are paid (lib/payments): on FlockStack Cloud their own Stripe account, connected through
		// Stripe Connect (Standard). The flags are what Stripe last said (account.updated, or a status check); a self-hosted
		// server charges with its own key and has none of this.
		payments: {
			stripeAccountId: { type: String },
			chargesEnabled: { type: Boolean },
			payoutsEnabled: { type: Boolean },
			detailsSubmitted: { type: Boolean },
			country: { type: String },
			connectedAt: { type: Date },
			checkedAt: { type: Date },
			deauthorizedAt: { type: Date },
		},
		// The owner deleted the account (lib/account-deletion.js): it stopped at once, and its data goes for good at
		// purgeAt unless they sign in and restore it before. Once the purge has started, it can't be restored.
		deletion: {
			requestedAt: { type: Date },
			purgeAt: { type: Date },
			purgeStartedAt: { type: Date },
		},
	},
	{ timestamps: true }
);

accountSchema.index(
	{ stripeCustomerId: 1 },
	{ unique: true, partialFilterExpression: { stripeCustomerId: { $type: "string" } } }
);
accountSchema.index({ stripeSubscriptionId: 1 }, { partialFilterExpression: { stripeSubscriptionId: { $type: "string" } } });
accountSchema.index({ polarCustomerId: 1 }, { unique: true, partialFilterExpression: { polarCustomerId: { $type: "string" } } });
accountSchema.index({ polarSubscriptionId: 1 }, { partialFilterExpression: { polarSubscriptionId: { $type: "string" } } });
accountSchema.index({ "payments.stripeAccountId": 1 }, { unique: true, partialFilterExpression: { "payments.stripeAccountId": { $type: "string" } } });
accountSchema.index({ createdAt: -1 });
accountSchema.index({ "ses.tenantName": 1 }, { unique: true, partialFilterExpression: { "ses.tenantName": { $type: "string" } } });
accountSchema.index({ "postshiba.tenantSlug": 1 }, { unique: true, partialFilterExpression: { "postshiba.tenantSlug": { $type: "string" } } });

export default mongoose.models.Account || mongoose.model("Account", accountSchema);
