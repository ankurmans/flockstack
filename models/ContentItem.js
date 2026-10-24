import mongoose from "../lib/docdb/index.js";
import { accountScoped } from "../lib/account-scope.js";
import { CONTENT_CHANNELS, CONTENT_STATES, FUNNEL_STAGES } from "../lib/content-rules.js";

// One piece of the content calendar (lib/content-items.js): a newsletter issue, or a post for LinkedIn, with its copy, visuals,
// review and the day it is planned for. The plan is editorial intent only: nothing here sends, schedules or publishes, and
// state is the editorial state, apart from the delivery of the campaign an issue is linked to.
const contentItemSchema = new mongoose.Schema(
	{
		newsletterId: { type: mongoose.Schema.Types.ObjectId, ref: "Newsletter", required: true },
		channel: { type: String, enum: CONTENT_CHANNELS, required: true },
		// The caller's own key for the item: a repeated import with the same one finds this item instead of making another.
		externalId: { type: String, trim: true },
		title: { type: String, trim: true, default: "" },
		// The reader's problem and what they should take away.
		obstacle: { type: String, trim: true, default: "" },
		takeaway: { type: String, trim: true, default: "" },
		funnelStage: { type: String, enum: FUNNEL_STAGES },
		pillar: { type: String, trim: true, default: "" },
		hook: { type: String, default: "" },
		body: { type: String, default: "" },
		cta: { type: String, trim: true, default: "" },
		destinationUrl: { type: String, trim: true, default: "" },
		references: [
			{
				_id: false,
				label: { type: String, trim: true },
				url: { type: String, required: true },
				kind: { type: String, enum: ["reference", "evidence"], default: "reference" },
			},
		],
		// Private: never in an export of the post, never sent anywhere.
		notes: { type: String, default: "" },
		// A newsletter item's issue, or the issue a post is derived from. An issue belongs to one newsletter item.
		campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "Campaign" },
		// Visuals in the order they are posted, each a record of the media library (models/Upload.js): no file is copied.
		assets: [
			{
				_id: false,
				mediaId: { type: mongoose.Schema.Types.ObjectId, ref: "Upload", required: true },
				altText: { type: String, trim: true, default: "" },
				kind: { type: String, enum: ["image", "pdf"], required: true },
			},
		],
		batchId: { type: mongoose.Schema.Types.ObjectId, ref: "EditorialBatch" },
		batchPosition: { type: Number },
		// The plan: a calendar day and, optionally, a wall-clock time in a timezone, with the instant that is (plannedAt, worked
		// out again when the plan changes). slotOrder: the place among the day's items.
		plannedDate: { type: String },
		plannedTime: { type: String },
		timeZone: { type: String },
		plannedAt: { type: Date },
		slotOrder: { type: Number },
		// The last moves of the plan, newest last.
		moves: [{ _id: false, at: { type: Date }, by: { type: String }, from: { type: String }, to: { type: String } }],
		state: { type: String, enum: CONTENT_STATES, default: "idea" },
		// Counts the changes to what approval is about; an approval holds for the version it was given to.
		contentVersion: { type: Number, default: 1 },
		review: {
			requestedAt: { type: Date },
			requestedBy: { type: String },
			decision: { type: String, enum: ["approved", "changes_requested"] },
			decidedAt: { type: Date },
			decidedBy: { type: String },
			note: { type: String },
			approvedAt: { type: Date },
			approvedVersion: { type: Number },
			// The linked issue's words when it was approved, to tell if it changed since (an issue's words live on the campaign).
			campaignDigest: { type: String },
			// An edit took the approval back at this time.
			editedAfterApprovalAt: { type: Date },
		},
		// Recorded by hand: where a manual post went and when. Never set by FlockStack posting anything.
		publicationUrl: { type: String },
		deliveredAt: { type: Date },
		deliveredBy: { type: String },
		createdBy: { type: String },
	},
	{ timestamps: true }
);

contentItemSchema.plugin(accountScoped);
contentItemSchema.index({ accountId: 1, externalId: 1 }, { unique: true, partialFilterExpression: { externalId: { $type: "string" } } });
contentItemSchema.index({ accountId: 1, campaignId: 1 }, { unique: true, partialFilterExpression: { campaignId: { $type: "string" }, channel: "newsletter" } });
contentItemSchema.index({ newsletterId: 1, plannedDate: 1 });
contentItemSchema.index({ batchId: 1, batchPosition: 1 });
contentItemSchema.index({ newsletterId: 1, createdAt: -1 });

export default mongoose.models.ContentItem || mongoose.model("ContentItem", contentItemSchema);
