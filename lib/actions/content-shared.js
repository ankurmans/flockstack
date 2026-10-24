import "server-only";
import * as z from "zod";
import { CHANNEL_LABELS, CONTENT_CHANNELS, CONTENT_STATES, FUNNEL_STAGES, LIMITS, isHttpUrl } from "@/lib/content-rules";

// The shapes the content calendar's actions share: what an item looks like to a caller, and the fields an author sets.

export const GROUP = "Content calendar";

const text = (max, about) => z.string().trim().max(max).describe(about);
const stateOutput = z.enum(CONTENT_STATES).describe("The editorial state: idea, drafting, ready_for_review, changes_requested, approved or delivered. Apart from a campaign's delivery status.");
const url = (about) =>
	z
		.string()
		.trim()
		.max(LIMITS.url)
		.refine((value) => value === "" || isHttpUrl(value), "Use an http:// or https:// address")
		.describe(about);

export const channelInput = z.enum(CONTENT_CHANNELS).describe(`${CONTENT_CHANNELS.map((channel) => `${channel} (${CHANNEL_LABELS[channel]})`).join(" or ")}. A newsletter item is an issue, sent by its campaign; a linkedin item is a post you publish by hand.`);

// The fields an author writes. Every one is optional here; the actions say which they need.
export const writableFields = {
	title: text(LIMITS.title, "The item's title. A newsletter item with a linked issue shows the issue's subject when it has none."),
	obstacle: text(LIMITS.obstacle, "The reader's obstacle or problem this item speaks to"),
	takeaway: text(LIMITS.takeaway, "What the reader should take away"),
	funnelStage: z.enum(FUNNEL_STAGES).describe("TOFU (reaching new readers), MOFU (considering) or BOFU (ready to act)"),
	pillar: text(LIMITS.pillar, "The content pillar it belongs to, in your own words"),
	hook: text(LIMITS.hook, "The first line or two, what a reader sees before 'see more'"),
	body: text(LIMITS.body, "The post's text, or a newsletter item's short description. A LinkedIn post takes 3,000 characters."),
	cta: text(LIMITS.cta, "The call to action"),
	destinationUrl: url("The address the call to action leads to. An empty string removes it."),
	references: z
		.array(
			z.object({
				label: text(LIMITS.label, "What the link is").optional(),
				url: url("The address").min(1),
				kind: z.enum(["reference", "evidence"]).optional().describe("reference (default) or evidence for a claim in the copy"),
			})
		)
		.max(LIMITS.references)
		.describe(`References and evidence links, ${LIMITS.references} at most. Replaces the list.`),
	notes: text(LIMITS.notes, "Private editorial notes: never part of the post, never sent anywhere"),
};

const CampaignRefSchema = z.object({
	id: z.string(),
	subject: z.string(),
	status: z.string().describe("The campaign's own status: draft, scheduled, held, sending, paused or sent"),
	scheduledAt: z.string().nullable(),
	sentAt: z.string().nullable(),
	url: z.string().describe("The campaign in the dashboard, where it is edited, scheduled and sent"),
});

const ReviewSchema = z.object({
	requestedAt: z.string().nullable(),
	requestedBy: z.string().nullable(),
	decision: z.enum(["approved", "changes_requested"]).nullable().describe("The owner's last decision. An edit after approval clears it."),
	decidedAt: z.string().nullable(),
	note: z.string().nullable().describe("What the owner wrote with the decision"),
	approvedAt: z.string().nullable(),
	approvedVersion: z.number().int().nullable(),
	editedAfterApproval: z.boolean().describe("The words, visuals or linked issue changed after the owner approved: the approval no longer holds"),
	editedAfterApprovalAt: z.string().nullable(),
	approvalValid: z.boolean().describe("The item is approved and nothing it is about changed since"),
});

const DeliverySchema = z.object({
	mode: z.enum(["campaign", "manual"]).describe("campaign: sent by FlockStack through its campaign. manual: posted by hand; FlockStack never posts."),
	status: z.string().describe("campaign: no_issue, issue_missing or the campaign's status (draft, scheduled, sending, paused, sent). manual: not_posted or posted."),
	at: z.string().nullable().describe("When it goes out or went out (campaign), or when it was posted (manual)"),
	url: z.string().nullable().describe("Where a manual post was published"),
});

const PlanFields = {
	plannedDate: z.string().nullable().describe("The day it is planned for, YYYY-MM-DD, in timeZone. null: it is in the backlog. Planning never sends, schedules or publishes."),
	plannedTime: z.string().nullable().describe("The wall-clock time, HH:mm, or null for a day with no time"),
	timeZone: z.string().nullable().describe("The IANA timezone the date and time are in"),
	plannedAt: z.string().nullable().describe("The instant plannedTime is in timeZone, UTC. null without a time."),
	slot: z.number().int().nullable().describe("The place among that day's items, 1 first"),
};

export const ItemSummarySchema = z.object({
	id: z.string(),
	newsletterId: z.string(),
	channel: z.enum(CONTENT_CHANNELS),
	externalId: z.string().nullable(),
	title: z.string(),
	funnelStage: z.enum(FUNNEL_STAGES).nullable(),
	pillar: z.string().nullable(),
	batchId: z.string().nullable(),
	state: stateOutput,
	...PlanFields,
	campaign: CampaignRefSchema.nullable().describe("The linked issue as it is now: a newsletter item's own issue, or the one a post is derived from"),
	assetCount: z.number().int(),
	canApprove: z.boolean().describe("Nothing stops it from being approved"),
	blockerCount: z.number().int(),
	review: ReviewSchema,
	delivery: DeliverySchema,
	url: z.string().describe("The item in the dashboard"),
	updatedAt: z.string().nullable(),
});

const IssueSchema = z.object({ code: z.string(), message: z.string() });

export const ItemSchema = ItemSummarySchema.extend({
	obstacle: z.string(),
	takeaway: z.string(),
	hook: z.string(),
	body: z.string(),
	cta: z.string(),
	destinationUrl: z.string(),
	postText: z.string().describe("The post as it is copied to paste into LinkedIn: hook, body, call to action and destination address"),
	references: z.array(z.object({ label: z.string(), url: z.string(), kind: z.enum(["reference", "evidence"]) })),
	notes: z.string(),
	assets: z.array(
		z.object({
			position: z.number().int().describe("Where it is in the post, 1 first"),
			mediaId: z.string().describe("The media library record"),
			kind: z.enum(["image", "pdf"]).describe("A picture, or a PDF carousel"),
			altText: z.string(),
			url: z.string().nullable().describe("The file, to download. null if it left the media library."),
			name: z.string().nullable(),
			contentType: z.string().nullable(),
			bytes: z.number().int().nullable(),
			isMissing: z.boolean(),
		})
	),
	version: z.number().int().describe("Counts the changes to the item's content"),
	readiness: z.object({
		canApprove: z.boolean(),
		blockers: z.array(IssueSchema).describe("What must be fixed before it can be approved: missing copy, call to action, visual or alt text, a post over LinkedIn's limit, an issue not linked"),
		warnings: z.array(IssueSchema).describe("Worth a look; never stops an approval"),
	}),
	publicationUrl: z.string().nullable(),
	deliveredAt: z.string().nullable(),
	deliveredBy: z.string().nullable(),
	moves: z.array(z.object({ at: z.string().nullable(), by: z.string(), from: z.string().nullable(), to: z.string().nullable() })).describe("The last moves of its planned day"),
	createdBy: z.string().nullable(),
	createdAt: z.string().nullable(),
});

export const PatternSchema = z.object({
	stages: z.array(z.enum(FUNNEL_STAGES)).min(1).max(LIMITS.patternStages).describe("The funnel stages in the order they repeat, such as TOFU, MOFU, BOFU, TOFU, TOFU"),
	cadence: z
		.object({
			weekdays: z.array(z.number().int().min(1).max(7)).max(7).optional().describe("The weekdays slots fall on, 1 (Monday) to 7 (Sunday). Use this or everyDays."),
			everyDays: z.number().int().min(1).max(60).optional().describe("A slot every this many days. Default 1."),
			perDay: z.number().int().min(1).max(5).optional().describe("Slots on a day, 1 by default"),
			time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:mm").optional().describe("The wall-clock time of every slot, HH:mm. Without one, a slot is a day."),
			timeZone: z.string().max(64).optional().describe("The IANA timezone of the slots. Default UTC."),
		})
		.optional()
		.describe("When slots fall. Default: every day."),
});

export const PatternOutputSchema = z.object({
	stages: z.array(z.string()),
	cadence: z.object({
		weekdays: z.array(z.number().int()).nullable(),
		everyDays: z.number().int().nullable(),
		perDay: z.number().int(),
		time: z.string().nullable(),
		timeZone: z.string().nullable(),
	}),
});
