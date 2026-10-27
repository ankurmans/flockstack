import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";
import { AB_TEST_METRICS, AB_TEST_STATUSES } from "../lib/ab-test-rules.js";
import { PUBLISH_TARGETS } from "../lib/archive-issues.js";
import { RESEND_TARGETS } from "../lib/resend-rules.js";
import { AUDIENCES } from "../lib/tiers.js";

export const CAMPAIGN_STATUSES = ["draft", "scheduled", "held", "sending", "paused", "sent", "canceled"];

const counter = { type: Number, default: 0 };

const campaignSchema = new mongoose.Schema(
	{
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		listIds: { type: [String], default: undefined },
		excludeListIds: { type: [String], default: undefined },
		internalLinks: { type: [{ id: String, href: String }], default: undefined },
		internalLinkIds: { type: [String], default: undefined },
		authorId: String,
		// An outside edit or restore revokes an old shared room even when its text is identical.
		editorResetId: String,
		externalId: { type: String, trim: true },
		kind: { type: String, enum: ["issue", "note"], default: "issue" },
		shortPostDigest: { type: mongoose.Schema.Types.Mixed },
		subject: { type: String, trim: true, default: "" },
		previewText: { type: String, trim: true, default: "" },
		// The name in this issue's From field, over the newsletter's; the address stays the newsletter's.
		fromName: { type: String, trim: true },
		// rich: written in the editor, stored as an HTML fragment in html. html: a designed document sent
		// as is. markdown: older drafts and API campaigns.
		format: { type: String, enum: ["markdown", "html", "rich"], default: "rich" },
		markdown: { type: String, default: "" },
		html: { type: String, default: "" },
		status: { type: String, enum: CAMPAIGN_STATUSES, default: "draft" },
		// Why a send paused itself; a code from lib/account-state.js when the account or plan stopped it.
		pauseReason: { type: String },
		pauseCode: { type: String },
		// Its owner resumed it from a pause for its bounce or complaint rates: from then on, only the block level
		// stops it (lib/rate-levels.js).
		ratesAcceptedAt: { type: Date },
		// Who the issue is for: every active contact, only free readers, or only paid readers (lib/tiers.js). A paid issue
		// shows a teaser on the web archive; its full text is only in the email.
		audience: { type: String, enum: AUDIENCES, default: "all" },
		// A paid issue for one paid tier or higher: the tier picked (audienceMinTier) and the ids it reaches, worked out when
		// the campaign was saved (lib/tier-rules.js). Without them a paid issue goes to every paid tier.
		audienceMinTier: { type: String },
		audienceTiers: { type: [String], default: undefined },
		// Warm-up: send to the most engaged contacts first, capped at audienceLimit.
		audienceLimit: { type: Number, min: 1 },
		// Contacts never mailed before go out in steps: a first slice, a check, then the rest (lib/first-send.js), over
		// restHours in a spread send.
		firstSend: {
			slice: { type: Number },
			held: { type: Number },
			checkAt: { type: Date },
			checkedAt: { type: Date },
			restHours: { type: Number },
		},
		// Sent to a saved segment (models/Segment.js) instead of every active contact. Its rules are copied at the first send
		// (segmentSnapshot), so later steps and resumes keep the audience even if the segment changes or goes.
		segmentId: { type: mongoose.Schema.Types.ObjectId, ref: "Segment" },
		segmentSnapshot: { type: mongoose.Schema.Types.Mixed },
		// Several segments: contacts in any of segmentIds (segmentId is its first), and in none of excludeSegmentIds. The
		// snapshot then holds each one's rules as include and exclude (lib/segments.js).
		segmentIds: { type: [mongoose.Schema.Types.ObjectId], default: undefined },
		excludeSegmentIds: { type: [mongoose.Schema.Types.ObjectId], default: undefined },
		source: { type: String, default: "dashboard" },
		// The series (models/SeriesPlan.js) that made this issue.
		seriesId: { type: mongoose.Schema.Types.ObjectId, ref: "SeriesPlan" },
		scheduledAt: { type: Date },
		// A send the dashboard holds for its undo window (lib/send-hold.js): held until sendAfter, then a job releases it. claimedAt
		// is the release taking it, after which undo is too late. before: the audience fields as they were, for undo.
		hold: {
			sendAfter: { type: Date },
			seconds: { type: Number },
			recipients: { type: Number },
			claimedAt: { type: Date },
			before: { type: mongoose.Schema.Types.Mixed },
		},
		startedAt: { type: Date },
		// A send spread over hours (lib/send-spread.js): about when its last batch goes out, and the hours its size gave
		// it next to the account's proven volume, kept for its resumes. Each next step gets its own.
		sendingUntil: { type: Date },
		spreadHours: { type: Number },
		sentAt: { type: Date },
		// When its latest step finished going out: a day later, it counts toward the account's proven volume.
		finishedAt: { type: Date },
		testSentAt: { type: Date },
		archiveSlug: { type: String, trim: true, lowercase: true },
		thumbnailUrl: { type: String, trim: true },
		// Set while the issue has audio and its writer ticked "Listen to this issue" (lib/audio.js): emails link to the player
		// on the web page, with the audio's length.
		listen: {
			minutes: { type: Number },
		},
		// Unlisted issues keep their /p/slug page but stay off the archive index.
		archiveListed: { type: Boolean, default: true },
		// Email only issues are also unlisted, and have no page at all; web only ones are published without an email.
		publishTo: { type: String, enum: PUBLISH_TARGETS },
		// This issue's own word on comments, over the newsletter's setting: on or off. Without one it follows the newsletter.
		comments: { type: String, enum: ["on", "off"] },
		// The issue's tags (lib/issue-tags.js) and their web-address forms, in step: the website's tag pages find an issue by
		// tagSlugs.
		tags: { type: [String], default: undefined },
		tagSlugs: { type: [String], default: undefined },
		// What search engines and social cards show for the issue's page, over the subject, the preview text and the first
		// picture (lib/archive-seo.js): empty fields fall back to them. noindex asks search engines to leave the page out and
		// keeps it out of the sitemap and llms.txt. updatedAt: the last change, for the sitemap's lastmod.
		seo: {
			title: { type: String, trim: true },
			description: { type: String, trim: true },
			imageUrl: { type: String, trim: true },
			noindex: { type: Boolean },
			updatedAt: { type: Date },
		},
		// Pinned issues sit in the Featured row at the top of the archive.
		archivePinned: { type: Boolean, default: false },
		// Put away from the campaign list by a bulk archive: the web page is unlisted too (archivedUnlisted says the archive
		// did it, so unarchiving lists it again).
		archivedAt: { type: Date },
		archivedUnlisted: { type: Boolean },
		// An issue brought from another platform by a post import (lib/post-import.js): "<source>:<its ID there>", so the
		// same post is never imported twice into a newsletter, and where it came from. It went out before, from there: it is
		// sent with no emails and no stats.
		importKey: { type: String },
		importedFrom: {
			source: { type: String },
			url: { type: String },
			author: { type: String },
		},
		// Archive page views, once per browser and day.
		webViews: { type: Number, default: 0 },
		stats: {
			recipients: counter,
			sent: counter,
			delivered: counter,
			bounced: counter,
			complained: counter,
			opened: counter,
			clicked: counter,
			unsubscribed: counter,
			failed: counter,
		},
		// A subject line test (lib/ab-tests.js): variants[0] is the campaign's own subject, copied again as the send starts.
		// The test slice is testPercent of the audience; waitMinutes after it went out, the winner by metric goes to the
		// rest, within the send's own limit (audienceLimit here; the campaign's own is the slice's while it tests). The
		// counters are the test slice's alone.
		abTest: {
			variants: [
				{
					_id: false,
					subject: { type: String, trim: true },
					previewText: { type: String, trim: true },
					sent: counter,
					opened: counter,
					clicked: counter,
				},
			],
			testPercent: { type: Number },
			waitMinutes: { type: Number },
			metric: { type: String, enum: AB_TEST_METRICS },
			status: { type: String, enum: AB_TEST_STATUSES },
			audienceLimit: { type: Number },
			pickAt: { type: Date },
			winner: { type: Number },
			pickedAt: { type: Date },
			restSentAt: { type: Date },
			problem: { type: String },
		},
		// A resend (lib/resends.js): the sent campaign it copies, which of its readers it goes to, and that campaign's page,
		// which its emails link to as their own. The campaign it copies keeps resentAs: one resend each.
		resend: {
			of: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign" },
			to: { type: String, enum: RESEND_TARGETS },
			slug: { type: String },
		},
		resentAs: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign" },
		// The list cleanup at this send: last-chance emails sent instead of the issue, and contacts made dormant.
		lastChance: {
			recipients: counter,
			sent: counter,
			delivered: counter,
			bounced: counter,
			complained: counter,
			failed: counter,
			dormant: counter,
		},
	},
	{ timestamps: true }
);

campaignSchema.plugin(accountScoped);
campaignSchema.index({ newsletterId: 1, createdAt: -1 });
campaignSchema.index({ accountId: 1, status: 1 });
campaignSchema.index({ newsletterId: 1, startedAt: -1 });
// The hourly sweep of held sends nobody released.
campaignSchema.index({ status: 1, "hold.sendAfter": 1 });
campaignSchema.index(
	{ newsletterId: 1, importKey: 1 },
	{ unique: true, partialFilterExpression: { importKey: { $type: "string" } } }
);
// Unique across accounts: /p/<slug> on the app's domain finds an issue by its slug alone.
campaignSchema.index(
	{ archiveSlug: 1 },
	{ unique: true, partialFilterExpression: { archiveSlug: { $type: "string" } } }
);

campaignSchema.index({ accountId: 1, newsletterId: 1, status: 1, sentAt: 1 });

campaignSchema.index({ accountId: 1, externalId: 1 }, { unique: true, partialFilterExpression: { externalId: { $type: "string" } } });
campaignSchema.index({ accountId: 1, newsletterId: 1, kind: 1, status: 1, sentAt: -1, _id: -1 });

export default mongoose.models.Campaign || mongoose.model("Campaign", campaignSchema);
