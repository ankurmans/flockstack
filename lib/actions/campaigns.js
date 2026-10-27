import { randomUUID } from "node:crypto";
import { campaignContentHash, campaignContentCondition } from "@/lib/campaign-content-hash";
import { readIssueLinkRefs } from "@/lib/issue-link-rules";
import { assertShortPostInput, shortPostFields } from "@/lib/short-post-rules";
import { campaignListChanges, MAX_AUDIENCE_LISTS } from "@/lib/mailing-lists";
import "server-only";
import * as z from "zod";
import { ObjectId } from "@/lib/docdb";
import { AB_TEST, AB_TEST_METRICS, VARIANT_LABELS, buildVariants, hasAbTest } from "@/lib/ab-test-rules";
import { scoped } from "@/lib/account-scope";
import { getAccountSendProblem } from "@/lib/account-state";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import {
	assertSendingEnabled,
	dateOutput,
	findNewsletter,
	findTestRecipient,
	idInput,
	newsletterFilterInput,
	newsletterInput,
	readPositiveInteger,
	toIso,
} from "@/lib/actions/shared";
import { findTemplate, getTemplateContent } from "@/lib/actions/templates";
import { notifyActivity } from "@/lib/alerts";
import { PUBLISHED_STATUSES, getIssuePageUrl, revalidateArchive } from "@/lib/archive-data";
import { deleteAudioOfCampaign } from "@/lib/audio";
import { PUBLISH_TARGETS } from "@/lib/archive-issues";
import { isArchiveSlugTaken, uniqueArchiveSlug } from "@/lib/archive-slugs";
import { MAX_ISSUE_TAGS, getTagSlug, toIssueTags } from "@/lib/issue-tags";
import { MAX_TAG_LENGTH } from "@/lib/tag-rules";
import { recentCampaignsPipeline } from "@/lib/campaign-queries";
import { recordVersion } from "@/lib/campaign-versions";
import { AUDIENCE_SORT } from "@/lib/audience";
import { summarizePreview } from "@/lib/cleanup";
import { FIRST_SEND, LIMITS, WARMUP, getAppUrl } from "@/lib/config";
import { formatNumber } from "@/lib/format";
import { listCampaignLinks } from "@/lib/link-clicks";
import { MESSAGE_STATS_GROUP } from "@/lib/message-stats";
import { formatRate } from "@/lib/rate-levels";
import { RESEND_DELAY_HOURS, RESEND_TARGETS, isResend } from "@/lib/resend-rules";
import { getScheduleProblem } from "@/lib/schedule";
import { SEO_LIMITS, getSeoProblem } from "@/lib/seo-rules";
import { getStartingHtml } from "@/lib/templates";
import { publishScheduledSend } from "@/lib/scheduling";
import {
	MAX_CAMPAIGN_SEGMENTS,
	countCampaignAudience,
	findSegmentByReference,
	getCampaignAudienceFilter,
	getCampaignSegmentIds,
	resolveCampaignSegment,
} from "@/lib/segments";
import { loadSender } from "@/lib/sender";
import { holdCampaignSend, releaseCampaign, undoHeldSend } from "@/lib/send-hold";
import { getUndoSeconds } from "@/lib/send-hold-rules";
import { checkCampaignSend, getCleanupPreview, queueCampaign, sendTestEmail, sendToMoreContacts } from "@/lib/sending";
import { getSendProblem, getWebPublishProblem } from "@/lib/sending-rules";
import { ARCHIVE_SLUG_PATTERN } from "@/lib/slug";
import { firstImageUrl } from "@/lib/thumbnail";
import { getNewsletterTiers, getTierIdsAtLeast } from "@/lib/tier-rules";
import { AUDIENCES, audienceTierFilter } from "@/lib/tiers";
import { countEmailsInFlight, getUsage } from "@/lib/usage";
import { MAX_BODY_BYTES, isObjectIdString } from "@/lib/validation";
import Campaign, { CAMPAIGN_STATUSES } from "@/models/Campaign";
import CampaignLink from "@/models/CampaignLink";
import Contact from "@/models/Contact";
import Message from "@/models/Message";
import Newsletter from "@/models/Newsletter";
import Segment from "@/models/Segment";

const GROUP = "Campaigns";
// A scheduled campaign stays editable until it goes out.
export const EDITABLE_STATUSES = ["draft", "scheduled"];
const LISTED_STATUSES = CAMPAIGN_STATUSES.filter((status) => status !== "canceled");
const FORMATS = ["markdown", "rich", "html"];
const STAT_KEYS = ["recipients", "sent", "delivered", "opened", "clicked", "bounced", "complained", "unsubscribed", "failed"];
const LAST_CHANCE_KEYS = ["recipients", "sent", "delivered", "bounced", "complained", "failed", "dormant"];
const COPY_SUFFIX = " (copy)";
const SUMMARY_FIELDS = { html: 0, markdown: 0 };
const IRREVERSIBLE = "Sending can't be undone: emails can't be recalled once they go out. Ask the user to confirm first.";
const FIRST_SEND_WAIT_HOURS = FIRST_SEND.waitMinutes / 60;
const { pause, block } = LIMITS;
const RATE_LEVELS = `Past ${formatRate(pause.bounceRate)} hard bounces (at least ${pause.minBounces}) or ${formatRate(pause.complaintRate)} complaints (at least ${pause.minComplaints}), the campaign pauses with pauseCode high_rates, or first_send_slice for a slice, and resume_campaign sends the rest. Past ${formatRate(block.bounceRate)} (at least ${block.minBounces}) or ${formatRate(block.complaintRate)} (at least ${block.minComplaints}), the account is blocked.`;
const PACE = `FlockStack Cloud paces a send by the volume its account has proven: its largest campaign of the last ${WARMUP.provenDays} days whose bounces and complaints stayed under the pause level, counted a day after it went out. A send, with what the account's other sends still have to send or sent in the last ${WARMUP.recentHours} hours, goes at full speed up to ${WARMUP.quickEmails} emails, or that volume times ${WARMUP.growth.first} on the first day of the account's ${WARMUP.days}-day warm-up, rising to ${WARMUP.growth.last} by its last day and after it. A bigger send goes out over ${WARMUP.minHours} hours plus ${WARMUP.hoursPerDoubling} for each time it doubles that, ${WARMUP.maxHours} at most (spreadHours, sendingUntil); a resume keeps the pace, each step of send_campaign_to_more gets its own`;
const HOW_IT_GOES_OUT = `${PACE}. Contacts never mailed before go in steps: a slice first, the rest ${FIRST_SEND_WAIT_HOURS} hours after it if the slice's bounces and complaints stay under the pause level. A campaign with a subject line test (update_campaign's abTest) goes to its test slice first, and its winner to the rest after the wait, with no other call. ${RATE_LEVELS}`;

const campaignId = idInput("campaign");
export const subjectInput = z.string().trim().max(200).describe("Subject line, 200 characters at most");
export const previewTextInput = z.string().trim().max(300).describe("Text inbox apps show after the subject, 300 characters at most");
const publishToInput = z
	.enum(PUBLISH_TARGETS)
	.describe(
		"Where the issue goes: both (the default) by email and on the website, email (no web page; the email has no read online link), or web (published on the website with no email: send_campaign and schedule_campaign publish it, and nothing is sent)"
	);
export const tagsInput = z
	.array(z.string().trim().max(60))
	.max(MAX_ISSUE_TAGS)
	.describe(`The issue's tags, ${MAX_ISSUE_TAGS} at most: letters, digits and spaces, lowercased. The website lists them as chips on the issue and gives each a page of its issues. An empty list removes them.`);
const fromNameInput = z
	.string()
	.trim()
	.max(100)
	.describe("The name in this issue's From field, 100 characters at most; the address stays the newsletter's. Empty goes back to the newsletter's name.");
export const formatInput = z
	.enum(FORMATS)
	.describe(
		"markdown: Markdown laid out in the newsletter's design. rich: an HTML fragment (paragraphs, headings, links, images) in the same design, what the dashboard editor writes. html: a complete HTML email sent as is, with the footer added unless it contains {{unsubscribe_url}}."
	);
export const contentInput = z.string().max(MAX_BODY_BYTES).describe("The body in that format, 500 KB at most");
const audienceInput = z
	.enum(AUDIENCES)
	.describe(
		"Who gets it: all active contacts (the default), only free readers, or only paid readers. free and paid need the newsletter's paid tier (set_paid_tier). A paid issue's web page shows a teaser; the full text is only in the email."
	);
const paidTierInput = z
	.string()
	.trim()
	.max(100)
	.nullable()
	.optional()
	.describe(
		"With audience paid: a paid tier's ID or name, and the issue goes to the readers of that tier and every tier above it (list_paid_tiers lists them from the lowest). null: every paid tier, the default. Needs audience paid."
	);
const audienceLimitInput = z
	.number()
	.int()
	.min(1)
	.max(10_000_000)
	.optional()
	.describe("Send to this many contacts at most, the most engaged first. The rest can follow with send_campaign_to_more.");

const mailingListInput = z.array(z.string().min(1).max(64)).max(MAX_AUDIENCE_LISTS).optional();

const segmentInput = z
	.string()
	.trim()
	.max(100)
	.nullable()
	.optional()
	.describe("A saved segment's ID or name: the campaign goes to its active contacts (within its audience) instead of all the newsletter's. null goes back to everyone.");

const abTestInput = z
	.object({
		subjects: z
			.array(
				z.object({
					subject: subjectInput.min(1, "Add a subject"),
					previewText: previewTextInput.optional().describe("Its own preview text. Default: the campaign's."),
				})
			)
			.min(1)
			.max(AB_TEST.maxVariants - 1)
			.describe(`1 to ${AB_TEST.maxVariants - 1} more subject lines, tried against the campaign's own`),
		testPercent: z
			.number()
			.int()
			.min(AB_TEST.percent.min)
			.max(AB_TEST.percent.max)
			.optional()
			.describe(`The share of the audience the test goes to, the most engaged first, ${AB_TEST.percent.default}% by default`),
		waitMinutes: z
			.number()
			.int()
			.min(AB_TEST.waitMinutes.min)
			.max(AB_TEST.waitMinutes.max)
			.optional()
			.describe(`Minutes from the test slice going out to the winner going to the rest, ${AB_TEST.waitMinutes.default} by default`),
		metric: z
			.enum(AB_TEST_METRICS)
			.optional()
			.describe("How the winner is picked, per email sent: unique clicks (the default) or opens. Apple Mail opens every email it receives, so opens say less."),
	})
	.nullable()
	.optional()
	.describe(
		"A subject line test: the subjects go in turn to a slice of the audience when the campaign is sent, and the one that did best goes to the rest once the wait is over, within the send's limit. null removes it."
	);

const segmentsInput = z
	.array(z.string().trim().max(100))
	.max(MAX_CAMPAIGN_SEGMENTS)
	.nullable()
	.optional()
	.describe(`Up to ${MAX_CAMPAIGN_SEGMENTS} saved segments' IDs or names: the campaign goes to contacts in any of them. Empty or null goes back to everyone. Instead of segment.`);
const excludeSegmentsInput = z
	.array(z.string().trim().max(100))
	.max(MAX_CAMPAIGN_SEGMENTS)
	.nullable()
	.optional()
	.describe(`Up to ${MAX_CAMPAIGN_SEGMENTS} saved segments' IDs or names whose contacts don't get it, even when they're in its segments. Empty or null leaves out nobody.`);

const StatsSchema = z.object(Object.fromEntries(STAT_KEYS.map((key) => [key, z.number().int()])));
const SendProblemSchema = z.object({ code: z.string(), message: z.string() });
const AbTestSchema = z
	.object({
		status: z.enum(["draft", "testing", "picked"]).describe("draft until it's sent, testing until the winner is picked"),
		testPercent: z.number().int(),
		waitMinutes: z.number().int(),
		metric: z.enum(AB_TEST_METRICS),
		variants: z.array(
			z.object({
				label: z.string().describe("A is the campaign's own subject"),
				subject: z.string(),
				previewText: z.string(),
				sent: z.number().int(),
				opened: z.number().int(),
				clicked: z.number().int(),
				openRate: z.number().nullable(),
				clickRate: z.number().nullable(),
			})
		),
		pickAt: dateOutput.describe("About when the winner is picked"),
		winner: z.string().nullable().describe("The winning variant's label, once picked"),
		pickedAt: dateOutput,
		problem: z.string().nullable().describe("Why the winner didn't reach the rest; send_campaign_to_more sends it"),
	})
	.nullable();
export const CampaignSchema = z.object({
	contentHash: z.string().optional().describe("Content precondition for a subsequent draft edit, when full content was loaded"),
	id: z.string(),
	kind: z.enum(["issue", "note"]).describe("issue: a newsletter issue; note: a title-free short web post with no email"),
	newsletterId: z.string(),
	status: z.enum(CAMPAIGN_STATUSES),
	subject: z.string(),
	previewText: z.string(),
	authorId: z.string().nullable().describe("A guest author ID, or null for the newsletter writer"),
	fromName: z.string().nullable().describe("This issue's own sender name, or null for the newsletter's"),
	publishTo: z.enum(PUBLISH_TARGETS),
	format: z.enum(FORMATS),
	archiveSlug: z.string().nullable().describe("The issue's page is /p/<archiveSlug> on the archive"),
	archiveUrl: z.string().nullable().describe("The issue's public page, once sent with the archive on"),
	tags: z.array(z.string()).describe("The issue's tags, which the website shows on the issue and in a page for each"),
	archivePinned: z.boolean(),
	archiveListed: z.boolean().describe("In the website's list of issues and its feed; an unlisted issue keeps its page at its link"),
	archived: z.boolean().describe("Put away from the campaign list by bulk_update_campaigns archive"),
	seo: z
		.object({
			title: z.string().describe("The page's title for search engines and social cards; empty means the subject"),
			description: z.string().describe("The page's meta description; empty means the preview text, else the newsletter's description"),
			image: z.string().describe("The social card's picture; empty means the issue's first picture, else a generated card"),
			noindex: z.boolean().describe("Search engines are asked to leave the page out; it is also out of the sitemap and llms.txt"),
		})
		.describe("What search engines and social cards show for the issue's page"),
	audience: z.enum(AUDIENCES),
	paidTier: z.object({ id: z.string(), name: z.string() }).nullable().describe("With audience paid: the lowest paid tier it goes to (and every tier above it), or null for every paid tier"),
	audienceLimit: z.number().int().nullable(),
	listIds: z.array(z.string()).describe("Mailing lists included, any of them; empty means all eligible readers"),
	excludeListIds: z.array(z.string()).describe("Mailing lists excluded; exclusions win"),
	segmentId: z.string().nullable().describe("The saved segment the campaign goes to (the first of segmentIds), or null for every active contact"),
	segmentIds: z.array(z.string()).describe("The segments it goes to: contacts in any of them"),
	excludeSegmentIds: z.array(z.string()).describe("The segments it leaves out: contacts in any of them don't get it"),
	abTest: AbTestSchema.describe("Its subject line test, with each subject's results from the test slice, or null"),
	resend: z
		.object({ of: z.string(), to: z.enum(RESEND_TARGETS) })
		.nullable()
		.describe("A resend: the sent campaign it copies, and which of that campaign's readers it goes to"),
	resentAs: z.string().nullable().describe("The resend of this campaign, once resend_campaign made it"),
	scheduledAt: dateOutput,
	hold: z
		.object({
			sendAfter: z.string().describe("When the held send is released, ISO 8601"),
			recipients: z.number().int().describe("The emails it will send, counted when it was held"),
		})
		.nullable()
		.describe("Set while the dashboard holds a send for its undo window (status held); undo_campaign_send takes it back"),
	startedAt: dateOutput,
	sendingUntil: dateOutput.describe(
		`About when a paced send finishes, a first send's ${FIRST_SEND_WAIT_HOURS}-hour check included, or null at full speed`
	),
	spreadHours: z
		.number()
		.nullable()
		.describe("The hours this send, or its latest step, goes out over because it's bigger than its account's proven volume allows, or null at full speed"),
	sentAt: dateOutput,
	testSentAt: dateOutput,
	pauseReason: z.string().nullable(),
	pauseCode: z
		.string()
		.nullable()
		.describe("plan_limit_emails, account_blocked, high_rates, first_send_slice… when the send paused itself. resume_campaign goes on after high_rates and first_send_slice"),
	stats: StatsSchema,
	source: z.string().describe("dashboard or api"),
	dashboardUrl: z.string(),
	createdAt: dateOutput,
	updatedAt: dateOutput,
});
const CampaignDetailSchema = CampaignSchema.extend({
	content: z.string(),
	sendProblem: SendProblemSchema.nullable().describe("What blocks sending this draft right now, or null"),
	activeContacts: z.number().int().describe("Active contacts of its newsletter"),
	paidContacts: z.number().int().describe("Of those, the paid ones: who a paid issue goes to"),
	segment: z.object({ id: z.string(), name: z.string() }).nullable().describe("The segment it goes to. A sent campaign keeps the audience it went to."),
	audienceSize: z
		.number()
		.int()
		.describe(
			"Active contacts a send would reach now, suppressed addresses out, before the list cleanup: those of its audience (all, free or paid) that are in its segment, or all the newsletter's"
		),
});
const RateSchema = z.number().nullable();
const LinkSchema = z.object({
	index: z.number().int().describe("The link's place among the email's tracked links, from 0"),
	url: z.string(),
	uniqueClicks: z.number().int().describe("Recipients who clicked it, each once"),
	clicks: z.number().int().describe("Every click on it, repeats included"),
	clickRate: RateSchema.describe("Unique clicks of delivered emails, from 0 to 1"),
});

function toLink(link, reached) {
	return { index: link.index, url: link.url, uniqueClicks: link.uniqueClicks ?? 0, clicks: link.clicks ?? 0, clickRate: toRate(link.uniqueClicks ?? 0, reached) };
}

function toAbTest(campaign) {
	if (!hasAbTest(campaign)) return null;
	const { abTest } = campaign;
	const variants = abTest.status ? abTest.variants : buildVariants(campaign, abTest.variants.slice(1));
	return {
		status: abTest.status ?? "draft",
		testPercent: abTest.testPercent ?? AB_TEST.percent.default,
		waitMinutes: abTest.waitMinutes ?? AB_TEST.waitMinutes.default,
		metric: abTest.metric ?? "clicks",
		variants: variants.map((variant, index) => ({
			label: VARIANT_LABELS[index],
			subject: variant.subject ?? "",
			previewText: variant.previewText ?? "",
			sent: variant.sent ?? 0,
			opened: variant.opened ?? 0,
			clicked: variant.clicked ?? 0,
			openRate: toRate(variant.opened ?? 0, variant.sent ?? 0),
			clickRate: toRate(variant.clicked ?? 0, variant.sent ?? 0),
		})),
		pickAt: toIso(abTest.pickAt),
		winner: Number.isInteger(abTest.winner) ? VARIANT_LABELS[abTest.winner] : null,
		pickedAt: toIso(abTest.pickedAt),
		problem: abTest.problem ?? null,
	};
}

function toCampaign(campaign, newsletter) {
	const id = String(campaign._id);
	return {
		...((campaign.html !== undefined || campaign.markdown !== undefined) && { contentHash: campaignContentHash(campaign) }),
		id,
		kind: campaign.kind ?? "issue",
		newsletterId: String(campaign.newsletterId),
		status: campaign.status,
		subject: campaign.subject ?? "",
		previewText: campaign.previewText ?? "",
		fromName: campaign.fromName || null,
		authorId: campaign.authorId ?? null,
		publishTo: campaign.publishTo ?? "both",
		format: campaign.format ?? "rich",
		archiveSlug: campaign.archiveSlug ?? null,
		archiveUrl: getIssuePageUrl({ campaign, newsletter }),
		tags: campaign.tags ?? [],
		archivePinned: Boolean(campaign.archivePinned),
		archiveListed: campaign.archiveListed !== false,
		archived: Boolean(campaign.archivedAt),
		seo: { title: campaign.seo?.title ?? "", description: campaign.seo?.description ?? "", image: campaign.seo?.imageUrl ?? "", noindex: Boolean(campaign.seo?.noindex) },
		audience: campaign.audience ?? "all",
		paidTier: campaign.audienceMinTier ? { id: campaign.audienceMinTier, name: getNewsletterTiers(newsletter).find((tier) => tier.id === campaign.audienceMinTier)?.name ?? campaign.audienceMinTier } : null,
		audienceLimit: campaign.audienceLimit ?? null,
		listIds: campaign.listIds ?? [],
		excludeListIds: campaign.excludeListIds ?? [],
		segmentId: campaign.segmentId ? String(campaign.segmentId) : null,
		segmentIds: getCampaignSegmentIds(campaign).include,
		excludeSegmentIds: getCampaignSegmentIds(campaign).exclude,
		abTest: toAbTest(campaign),
		resend: isResend(campaign) ? { of: String(campaign.resend.of), to: campaign.resend.to } : null,
		resentAs: campaign.resentAs ? String(campaign.resentAs) : null,
		scheduledAt: toIso(campaign.scheduledAt),
		hold: campaign.status === "held" && campaign.hold?.sendAfter ? { sendAfter: toIso(campaign.hold.sendAfter), recipients: campaign.hold.recipients ?? 0 } : null,
		startedAt: toIso(campaign.startedAt),
		sendingUntil: toIso(campaign.sendingUntil),
		spreadHours: campaign.spreadHours ?? null,
		sentAt: toIso(campaign.sentAt),
		testSentAt: toIso(campaign.testSentAt),
		pauseReason: campaign.pauseReason ?? null,
		pauseCode: campaign.pauseCode ?? null,
		stats: Object.fromEntries(STAT_KEYS.map((key) => [key, campaign.stats?.[key] ?? 0])),
		source: campaign.source ?? "dashboard",
		dashboardUrl: `${getAppUrl()}/campaigns/${id}`,
		createdAt: toIso(campaign.createdAt),
		updatedAt: toIso(campaign.updatedAt),
	};
}

// The tags to store with the slug of each, or a validation error naming the one that isn't a tag.
export function readTags(values) {
	const result = toIssueTags(values);
	if (result.problem) throw actionError("validation_failed", result.problem);
	return { tags: result.tags, tagSlugs: result.tagSlugs };
}

// An email only issue is unlisted and has no page; the others are listed on the website.
function toPublishFields(publishTo) {
	return { publishTo, archiveListed: publishTo !== "email" };
}

export function pickDefined(object, keys) {
	return Object.fromEntries(keys.filter((key) => object[key] !== undefined).map((key) => [key, object[key]]));
}

// A test as a draft stores it: the campaign's own subject first, then the others; the send copies the first again.
function toAbTestDraft(input, campaign) {
	return {
		variants: buildVariants(campaign, input.subjects),
		testPercent: input.testPercent ?? AB_TEST.percent.default,
		waitMinutes: input.waitMinutes ?? AB_TEST.waitMinutes.default,
		metric: input.metric ?? "clicks",
	};
}

// Deleted (canceled) campaigns are gone as far as callers can tell.
export async function findCampaign(account, id) {
	const campaign = isObjectIdString(id) ? await Campaign.findOne(scoped(account, { _id: id })).lean() : null;
	if (!campaign || campaign.status === "canceled") throw actionError("not_found", "Campaign not found");
	return campaign;
}

function findCampaignNewsletter(account, campaign) {
	return Newsletter.findOne(scoped(account, { _id: campaign.newsletterId })).lean();
}

export async function reload(account, campaign) {
	const [fresh, newsletter] = await Promise.all([
		Campaign.findOne(scoped(account, { _id: campaign._id })).lean(),
		findCampaignNewsletter(account, campaign),
	]);
	return toCampaign(fresh, newsletter);
}

// The checks a send runs, with their codes: the account, the from address, then the email itself.
async function getSendBlocker(account, campaign, newsletter) {
	const accountProblem = getAccountSendProblem(account);
	if (accountProblem) return accountProblem;
	if (campaign.publishTo === "web") {
		const webProblem = getWebPublishProblem({ campaign, newsletter });
		return webProblem ? { code: "send_check_failed", message: webProblem } : null;
	}
	const sender = newsletter ? await loadSender(account, newsletter) : null;
	const problem = getSendProblem({ campaign, newsletter, sender });
	if (problem) return { code: problem === sender?.problem ? "sender_not_allowed" : "send_check_failed", message: problem };
	const segment = await findCampaignSegment(account, campaign);
	if (hasSegments(campaign) && !segment) return { code: "send_check_failed", message: "This campaign's segment was deleted: pick another audience" };
	return null;
}

async function assertCanSend(account, campaign, newsletter) {
	const blocker = await getSendBlocker(account, campaign, newsletter);
	if (blocker) throw actionError(blocker.code, blocker.message);
}

async function toCampaignDetail(account, campaign) {
	const newsletter = await findCampaignNewsletter(account, campaign);
	return {
		...toCampaign(campaign, newsletter),
		content: (campaign.format === "markdown" ? campaign.markdown : campaign.html) ?? "",
		sendProblem: EDITABLE_STATUSES.includes(campaign.status) ? await getSendBlocker(account, campaign, newsletter) : null,
		activeContacts: await Contact.countDocuments(scoped(account, { newsletterId: campaign.newsletterId, status: "active" })),
		paidContacts: await Contact.countDocuments(scoped(account, { newsletterId: campaign.newsletterId, status: "active", ...audienceTierFilter("paid") })),
		segment: await findCampaignSegment(account, campaign),
		audienceSize: await countCampaignAudience(campaign, { audience: campaign.audience ?? "all" }),
	};
}

// What the campaign's audience is called: its segment's name, or several segments' in and out. Null when it goes to
// everyone, or when a segment it names was deleted.
async function findCampaignSegment(account, campaign) {
	const { include } = getCampaignSegmentIds(campaign);
	try {
		const segment = await resolveCampaignSegment({ ...campaign, accountId: scoped(account).accountId });
		return segment ? { id: include[0] ?? "", name: segment.name } : null;
	} catch (error) {
		if (error.code === "not_found") return null;
		throw error;
	}
}

function hasSegments(campaign) {
	const { include, exclude } = getCampaignSegmentIds(campaign);
	return include.length + exclude.length > 0;
}

// Segments of the campaign's newsletter, by ID or name, each once.
async function findCampaignSegmentIds(account, newsletterId, references) {
	const ids = [];
	for (const reference of references) ids.push(String(await findCampaignSegmentId(account, newsletterId, reference)));
	return [...new Set(ids)];
}

// The fields that store a campaign's segments: segment is one, segments several (segmentId stays the first),
// excludeSegments the ones left out. Empty or null clears them.
async function readSegmentChanges(account, newsletterId, input) {
	const set = {};
	const unset = {};
	const include = input.segments !== undefined ? input.segments : input.segment === undefined ? undefined : input.segment ? [input.segment] : [];
	if (include !== undefined) {
		const ids = await findCampaignSegmentIds(account, newsletterId, include ?? []);
		if (ids.length > 0) Object.assign(set, { segmentId: ids[0], segmentIds: ids });
		else Object.assign(unset, { segmentId: 1, segmentIds: 1 });
	}
	if (input.excludeSegments !== undefined) {
		const ids = await findCampaignSegmentIds(account, newsletterId, input.excludeSegments ?? []);
		if (ids.length > 0) set.excludeSegmentIds = ids;
		else unset.excludeSegmentIds = 1;
	}
	return { set, unset };
}

// A segment of the campaign's newsletter, by ID or name.
async function findCampaignSegmentId(account, newsletterId, reference) {
	return (await findSegmentByReference(account, reference, newsletterId))._id;
}

// free and paid mean something once the newsletter has a paid tier.
async function assertAudienceAllowed(account, campaign, audience) {
	if (!audience || audience === "all" || audience === (campaign.audience ?? "all")) return;
	const newsletter = await findCampaignNewsletter(account, campaign);
	if (!newsletter?.paidTier?.enabled) throw actionError("validation_failed", "audience: turn on the newsletter's paid tier first (set_paid_tier)");
}

// The tier a paid issue is for: "a tier or higher" is worked out now, from the newsletter's tier order. Anything but a paid
// issue goes to no tier in particular.
async function readTierChanges(account, campaign, input) {
	const audience = input.audience ?? campaign.audience ?? "all";
	if (audience !== "paid") return { set: {}, unset: input.audience !== undefined || input.paidTier === null ? { audienceMinTier: 1, audienceTiers: 1 } : {} };
	if (input.paidTier === undefined) return { set: {}, unset: {} };
	if (input.paidTier === null) return { set: {}, unset: { audienceMinTier: 1, audienceTiers: 1 } };
	const newsletter = await findCampaignNewsletter(account, campaign);
	const tiers = getNewsletterTiers(newsletter);
	const wanted = input.paidTier.toLowerCase();
	const tier = tiers.find((candidate) => candidate.id === wanted || candidate.name.toLowerCase() === wanted);
	if (!tier) throw actionError("validation_failed", `paidTier: the newsletter has no paid tier ${JSON.stringify(input.paidTier)}`);
	return { set: { audienceMinTier: tier.id, audienceTiers: getTierIdsAtLeast(tiers, tier.id) }, unset: {} };
}

// A send that picks another audience than paid drops the paid tiers it was for.
const isLeavingPaid = (audience) => Boolean(audience) && audience !== "paid";

export function assertEditable(campaign, message) {
	if (!EDITABLE_STATUSES.includes(campaign.status)) throw actionError("conflict", message);
}

function statusConflict(campaign) {
	const messages = {
		sending: "This campaign is already sending",
		paused: "This campaign is paused: resume it instead",
		sent: "This campaign was already sent: send it to more contacts instead",
		held: "This send is on hold for its undo window: undo_campaign_send takes it back",
	};
	return actionError("conflict", messages[campaign.status] ?? `This campaign is ${campaign.status}`);
}

export function readContent(format, content) {
	const bytes = Buffer.byteLength(content, "utf8");
	if (bytes > MAX_BODY_BYTES) {
		throw actionError("validation_failed", `The content is ${Math.ceil(bytes / 1000)} KB. The limit is ${MAX_BODY_BYTES / 1000} KB.`);
	}
	return {
		format,
		internalLinks: format === "markdown" ? [] : readIssueLinkRefs(content),
		internalLinkIds: format === "markdown" ? [] : readIssueLinkRefs(content).map(({ id }) => id),
		[format === "markdown" ? "markdown" : "html"]: content,
		thumbnailUrl: firstImageUrl({ format, html: content, markdown: content }) ?? undefined,
	};
}

function notifySend(account, campaign, action) {
	return notifyActivity([`${action}: ${campaign.subject || "(no subject)"}`, `${getAppUrl()}/campaigns/${campaign._id}`], {
		accountId: account._id,
	});
}

function toRate(part, total) {
	return total ? Math.round((part / total) * 10_000) / 10_000 : null;
}

// Only a send capped to the most engaged has a next step. Contacts who left after receiving it make this
// a little low; the send itself skips everyone who has it.
async function countRemaining(campaign) {
	if (campaign.status !== "sent" || !campaign.audienceLimit || campaign.abTest?.status === "testing") return 0;
	const active = await countCampaignAudience(campaign, { audience: campaign.audience ?? "all" });
	return Math.max(0, active - (campaign.stats?.recipients ?? 0) - (campaign.lastChance?.recipients ?? 0));
}

async function setArchiveSlug(account, campaign, value) {
	const slug = String(value ?? "").trim().toLowerCase().replace(/-+$/, "");
	const isPublished = PUBLISHED_STATUSES.includes(campaign.status);
	if (!slug && isPublished) throw actionError("validation_failed", "A sent issue needs a URL");
	if (slug && !ARCHIVE_SLUG_PATTERN.test(slug)) throw actionError("validation_failed", "Use lowercase letters, digits and hyphens");
	if (slug === (campaign.archiveSlug ?? "")) return;
	if (slug && (await isArchiveSlugTaken(slug, { exceptId: campaign._id, newsletterId: campaign.newsletterId }))) throw actionError("conflict", "Another issue or a page of this newsletter uses this URL");
	try {
		await Campaign.updateOne(scoped(account, { _id: campaign._id }), slug ? { $set: { archiveSlug: slug } } : { $unset: { archiveSlug: 1 } });
	} catch (error) {
		if (error?.code === 11000) throw actionError("conflict", "Another issue uses this URL");
		throw error;
	}
	if (isPublished) revalidateArchive();
}

const listCampaigns = defineAction({
	name: "list_campaigns",
	tryWithoutPlan: true,
	title: "List campaigns",
	group: GROUP,
	description:
		"Lists campaigns, newest activity first: sent issues by send date, scheduled ones by send time, drafts by last edit. Content is left out; get_campaign has it.",
	http: { method: "GET", path: "/campaigns" },
	readOnly: true,
	example: { status: "sent", limit: 10 },
	input: z.object({
		newsletter: newsletterFilterInput,
		status: z.enum(LISTED_STATUSES).optional().describe("Only campaigns with this status"),
		kind: z.enum(["issue", "note"]).optional().describe("Only newsletter issues or short web posts. Default: both."),
		search: z.string().trim().max(100).optional().describe("Only campaigns whose subject contains this, ignoring case"),
		tag: z.string().trim().min(1).max(MAX_TAG_LENGTH).optional().describe("Only campaigns with this tag (its name or its web address form, as in tags)"),
		archived: z.boolean().optional().describe("true: only the campaigns put away with bulk_update_campaigns archive. Default: the rest, archived ones left out."),
		limit: z.number().int().min(1).max(200).optional().describe("How many, 50 by default, 200 at most"),
	}),
	output: z.object({ campaigns: z.array(CampaignSchema) }),
	handler: async ({ account, input }) => {
		const newsletter = input.newsletter ? await findNewsletter(account, input.newsletter) : null;
		const [campaigns, newsletters] = await Promise.all([
			Campaign.aggregate(
				recentCampaignsPipeline({
					accountId: scoped(account).accountId,
					limit: input.limit ?? 50,
					newsletterId: newsletter?._id,
					status: input.status,
					kind: input.kind,
					search: input.search,
					tagSlug: input.tag && getTagSlug(input.tag),
					archived: input.archived,
					fields: SUMMARY_FIELDS,
				})
			),
			Newsletter.find(scoped(account)).select({ slug: 1, archiveEnabled: 1, archiveHost: 1 }).lean(),
		]);
		const byId = new Map(newsletters.map((item) => [String(item._id), item]));
		return { campaigns: campaigns.map((campaign) => toCampaign(campaign, byId.get(String(campaign.newsletterId)))) };
	},
});

const getCampaign = defineAction({
	name: "get_campaign",
	tryWithoutPlan: true,
	title: "Get a campaign",
	group: GROUP,
	description: "Gets a campaign with its content, stats and, for drafts, what would block sending it now.",
	http: { method: "GET", path: "/campaigns/{id}" },
	readOnly: true,
	input: z.object({ id: campaignId }),
	output: CampaignDetailSchema,
	handler: async ({ account, input }) => toCampaignDetail(account, await findCampaign(account, input.id)),
});

const getCampaignReport = defineAction({
	name: "get_campaign_report",
	tryWithoutPlan: true,
	title: "Get a campaign's report",
	group: GROUP,
	description:
		"Delivery, open, click, bounce, complaint and unsubscribe rates of a sent campaign, clicks on each of its links, its list cleanup emails, results by inbox provider, and how many contacts a capped send hasn't reached yet. Bots and link scanners don't count as clicks.",
	http: { method: "GET", path: "/campaigns/{id}/report" },
	readOnly: true,
	input: z.object({ id: campaignId }),
	output: z.object({
		campaign: CampaignSchema,
		rates: z
			.object({
				delivered: RateSchema,
				opened: RateSchema,
				clicked: RateSchema,
				bounced: RateSchema,
				complained: RateSchema,
				unsubscribed: RateSchema,
			})
			.describe("Fractions from 0 to 1: delivered, bounced and complained of sent; opened, clicked and unsubscribed of delivered"),
		lastChance: z
			.object(Object.fromEntries(LAST_CHANCE_KEYS.map((key) => [key, z.number().int()])))
			.describe("List cleanup at this send: last-chance emails instead of the issue, and contacts made dormant"),
		providers: z.array(
			z.object({
				provider: z.string(),
				sent: z.number().int(),
				delivered: z.number().int(),
				opened: z.number().int(),
				clicked: z.number().int(),
				bounced: z.number().int(),
				complained: z.number().int(),
			})
		),
		links: z
			.array(LinkSchema)
			.describe("Each tracked link of the email in order, with its clicks. list_link_clicks lists who clicked one. Empty for campaigns sent before links were counted."),
		remaining: z.number().int().describe("Active contacts a capped send hasn't reached yet"),
		firstSend: z
			.object({ slice: z.number().int(), held: z.number().int(), checkAt: dateOutput, checkedAt: dateOutput })
			.nullable()
			.describe(
				`Contacts never mailed before go in steps: a first slice, then the held rest ${FIRST_SEND_WAIT_HOURS} hours after it if the slice's bounces and complaints stay under the pause level. ${RATE_LEVELS}`
			),
	}),
	handler: async ({ account, input }) => {
		const campaign = await findCampaign(account, input.id);
		const [newsletter, providers, remaining, links] = await Promise.all([
			findCampaignNewsletter(account, campaign),
			Message.aggregate([
				{ $match: { accountId: campaign.accountId, campaignId: campaign._id, kind: "campaign" } },
				{ $group: { _id: { $ifNull: ["$provider", "other"] }, ...MESSAGE_STATS_GROUP } },
				{ $sort: { sent: -1 } },
			]),
			countRemaining(campaign),
			listCampaignLinks(campaign),
		]);
		const { stats = {}, lastChance = {}, firstSend } = campaign;
		const reached = stats.delivered || stats.sent;
		return {
			campaign: toCampaign(campaign, newsletter),
			rates: {
				delivered: toRate(stats.delivered, stats.sent),
				opened: toRate(stats.opened, reached),
				clicked: toRate(stats.clicked, reached),
				bounced: toRate(stats.bounced, stats.sent),
				complained: toRate(stats.complained, stats.sent),
				unsubscribed: toRate(stats.unsubscribed, reached),
			},
			lastChance: Object.fromEntries(LAST_CHANCE_KEYS.map((key) => [key, lastChance[key] ?? 0])),
			providers: providers.filter(({ sent }) => sent > 0).map(({ _id, ...row }) => ({ provider: _id, ...row })),
			links: links.map((link) => toLink(link, reached)),
			remaining,
			firstSend: firstSend?.slice
				? { slice: firstSend.slice, held: firstSend.held ?? 0, checkAt: toIso(firstSend.checkAt), checkedAt: toIso(firstSend.checkedAt) }
				: null,
		};
	},
});

const LINK_CLICKS_PAGE = 50;

const listLinkClicks = defineAction({
	name: "list_link_clicks",
	tryWithoutPlan: true,
	title: "List who clicked a link",
	group: GROUP,
	description:
		"Lists the contacts who clicked one link of a sent campaign, 50 a page, in the order they were sent the email; pass nextCursor back as cursor for the next page. The link is its index in get_campaign_report's links. Deleted contacts are left out.",
	http: { method: "GET", path: "/campaigns/{id}/link-clicks" },
	readOnly: true,
	example: { link: 0 },
	input: z.object({
		id: campaignId,
		link: z.number().int().min(0).max(1000).describe("The link's index from get_campaign_report's links"),
		limit: z.number().int().min(1).max(100).optional().describe("Contacts per page, 50 by default, 100 at most"),
		cursor: z.string().max(40).optional().describe("nextCursor from the previous page"),
	}),
	output: z.object({
		link: LinkSchema,
		contacts: z.array(z.object({ id: z.string(), email: z.string(), status: z.string() })),
		nextCursor: z.string().nullable().describe("null on the last page"),
	}),
	handler: async ({ account, input }) => {
		const campaign = await findCampaign(account, input.id);
		const link = await CampaignLink.findOne(scoped(account, { campaignId: campaign._id, index: input.link })).lean();
		if (!link) throw actionError("not_found", "This campaign has no link with that index");
		if (input.cursor && !isObjectIdString(input.cursor)) throw actionError("validation_failed", "cursor: pass nextCursor back as it came");
		const limit = input.limit ?? LINK_CLICKS_PAGE;
		const messages = await Message.find(
			scoped(account, {
				campaignId: campaign._id,
				clickedAt: { $exists: true },
				clickedLinks: input.link,
				...(input.cursor && { _id: { $gt: input.cursor } }),
			})
		)
			.sort({ _id: 1 })
			.limit(limit + 1)
			.select({ contactId: 1 })
			.lean();
		const page = messages.slice(0, limit);
		const contacts = await Contact.find(scoped(account, { _id: { $in: page.map(({ contactId }) => contactId).filter(Boolean) } }))
			.select({ email: 1, status: 1 })
			.lean();
		const byId = new Map(contacts.map((contact) => [String(contact._id), contact]));
		const { stats = {} } = campaign;
		return {
			link: toLink(link, stats.delivered || stats.sent),
			contacts: page
				.map(({ contactId }) => byId.get(String(contactId)))
				.filter(Boolean)
				.map(({ _id, email, status }) => ({ id: String(_id), email, status })),
			nextCursor: messages.length > limit ? String(page.at(-1)._id) : null,
		};
	},
});

const createCampaign = defineAction({
	name: "create_campaign",
	tryWithoutPlan: true,
	title: "Create a draft campaign",
	group: GROUP,
	description:
		"Creates a draft. Nothing is sent: review it in the dashboard or with get_campaign, then send_test_email, schedule_campaign or send_campaign. It starts with the content you give, or with a template's (template), or empty in the newsletter's default style: the header and footer set with update_newsletter's defaultStyle around a place to write.",
	http: { method: "POST", path: "/campaigns", status: 201 },
	rateLimit: { limit: 60, window: "1 h" },
	example: { subject: "This week", previewText: "Three links worth your time", content: "# This week\n\nThree links worth your time." },
	input: z.object({
		newsletter: newsletterInput,
		externalId: z.string().trim().min(1).max(160).optional().describe("A retry key unique in this account; repeated creation returns the same draft unchanged."),
		kind: z.enum(["issue", "note"]).optional().describe("Default: issue. note creates a short web-only post, with no visible title or email; up to 2,000 text characters. Cannot change after creation."),
		subject: subjectInput.optional(),
		previewText: previewTextInput.optional(),
		fromName: fromNameInput.optional(),
		authorId: z.string().max(64).nullable().optional().describe("Active guest author ID, or null for the newsletter writer"),
		publishTo: publishToInput.optional(),
		format: formatInput.optional().describe("markdown (the default when content is given), rich or html, as in update_campaign"),
		content: contentInput.optional(),
		template: z
			.string()
			.trim()
			.max(100)
			.optional()
			.describe("A template's ID (list_templates, of the same newsletter): the draft starts with its subject, preview text and content, and subject, previewText, format and content here replace them"),
		archiveSlug: z
			.string()
			.regex(ARCHIVE_SLUG_PATTERN, "Use lowercase letters, digits and dashes, 120 at most")
			.optional()
			.describe("The issue's page path once sent. Default: made from the subject; a taken slug gets a number."),
		audience: audienceInput.optional(),
		paidTier: paidTierInput,
		tags: tagsInput.optional(),
		listIds: mailingListInput.describe("Active mailing list IDs; include readers in any chosen list, within the tier and segment audience. Empty means every eligible reader."),
		excludeListIds: mailingListInput.describe("Active mailing list IDs to exclude; exclusions win. Empty excludes no lists."),
		segment: segmentInput,
		segments: segmentsInput,
		excludeSegments: excludeSegmentsInput,
	}),
	output: CampaignDetailSchema,
	handler: async ({ account, input, via }) => {
		const newsletter = await findNewsletter(account, input.newsletter, { _id: 1, paidTier: 1, paidTiers: 1, defaultStyle: 1 });
		const isNote = input.kind === "note";
		if (isNote) assertShortPostInput(input);
		if (input.externalId) {
			const existing = await Campaign.findOne(scoped(account, { externalId: input.externalId })).lean();
			if (existing) {
				if (String(existing.newsletterId) !== String(newsletter._id) || (existing.kind ?? "issue") !== (input.kind ?? "issue")) throw actionError("conflict", "This retry key belongs to another newsletter or post type");
				return toCampaignDetail(account, existing);
			}
		}
		if (input.audience && input.audience !== "all" && !newsletter.paidTier?.enabled) {
			throw actionError("validation_failed", "audience: turn on the newsletter's paid tier first (set_paid_tier)");
		}
		const template = input.template ? await findTemplate(account, input.template) : null;
		if (template && String(template.newsletterId) !== String(newsletter._id)) {
			throw actionError("validation_failed", "template: it belongs to another newsletter");
		}
		const start = isNote ? null : getStartingHtml(newsletter);
		const content = input.content
			? readContent(input.format ?? "markdown", input.content)
			: template
				? readContent(template.format, getTemplateContent(template))
				: start && (input.format ?? "rich") === "rich"
					? readContent("rich", start)
					: { format: input.format ?? (isNote ? "markdown" : "rich") };
		let campaign;
		try { campaign = await Campaign.create({
			accountId: account._id,
			...(input.externalId && { externalId: input.externalId }),
			kind: isNote ? "note" : "issue",
			newsletterId: newsletter._id,
			subject: input.subject ?? template?.subject ?? "",
			previewText: input.previewText ?? template?.previewText ?? "",
			...(input.fromName && { fromName: input.fromName }),
			...(input.publishTo && toPublishFields(input.publishTo)),
			internalLinks: [],
			internalLinkIds: [],
			...content,
			...(isNote && { ...shortPostFields(content), ...toPublishFields("web"), audience: "all" }),
			...(input.archiveSlug && { archiveSlug: await uniqueArchiveSlug(input.archiveSlug, { newsletterId: newsletter._id }) }),
			...(input.audience && { audience: input.audience }),
			...(await readTierChanges(account, { newsletterId: newsletter._id }, input)).set,
			...(await (await import("@/lib/authors")).authorChanges(account, newsletter._id, input.authorId)),
			...(input.tags && readTags(input.tags)),
			...(await campaignListChanges(account, newsletter._id, input)),
			...(await readSegmentChanges(account, newsletter._id, input)).set,
			source: via === "dashboard" ? "dashboard" : "api",
		}); } catch (error) {
			if (error?.code !== 11000 || !input.externalId) throw error;
			campaign = await Campaign.findOne(scoped(account, { externalId: input.externalId })).lean();
			if (!campaign || String(campaign.newsletterId) !== String(newsletter._id) || (campaign.kind ?? "issue") !== (input.kind ?? "issue")) throw actionError("conflict", "This retry key belongs to another draft");
			return toCampaignDetail(account, campaign);
		}
		return toCampaignDetail(account, campaign.toObject());
	},
});

const updateCampaign = defineAction({
	name: "update_campaign",
	tryWithoutPlan: true,
	title: "Update a draft campaign",
	group: GROUP,
	description:
		"Changes a draft or scheduled campaign's subject, preview text, sender name, content, audience, tags, segments in and out, subject line test or where it's published. Send only the fields to change; format goes with content. Sent campaigns can't change.",
	http: { method: "PATCH", path: "/campaigns/{id}" },
	idempotent: true,
	example: { subject: "This week, and one more link" },
	input: z.object({
		id: campaignId,
		expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/).optional().describe("Refuse a stale draft edit unless its exact previous content hash still matches"),
		subject: subjectInput.optional(),
		previewText: previewTextInput.optional(),
		fromName: fromNameInput.optional(),
		authorId: z.string().max(64).nullable().optional().describe("Active guest author ID, or null for the newsletter writer"),
		publishTo: publishToInput.optional(),
		format: formatInput.optional().describe("With content: the format it's in. Default: the campaign's current format."),
		content: contentInput.optional(),
		audience: audienceInput.optional(),
		paidTier: paidTierInput,
		tags: tagsInput.optional(),
		listIds: mailingListInput.describe("Active mailing list IDs; include readers in any chosen list, within the tier and segment audience. Empty means every eligible reader."),
		excludeListIds: mailingListInput.describe("Active mailing list IDs to exclude; exclusions win. Empty excludes no lists."),
		segment: segmentInput,
		segments: segmentsInput,
		excludeSegments: excludeSegmentsInput,
		abTest: abTestInput,
	}),
	output: CampaignSchema,
	handler: async ({ account, input }) => {
		const campaign = await findCampaign(account, input.id);
		if (input.expectedContentHash && campaignContentHash(campaign) !== input.expectedContentHash) throw actionError("conflict", "This draft changed in another editor. Keep a copy of your changes and reload its current version.");
		assertEditable(campaign, campaign.status === "sent" ? "Only drafts can be edited: a sent issue's web page changes with update_published_issue" : "Only drafts can be edited");
		if (campaign.kind === "note") assertShortPostInput(input);
		if (input.format !== undefined && input.content === undefined) throw actionError("validation_failed", "format: send content with it");
		if (input.abTest && isResend(campaign)) throw actionError("validation_failed", "abTest: a resend goes out with one subject");
		await assertAudienceAllowed(account, campaign, input.audience);

		const { thumbnailUrl, ...content } = input.content === undefined ? {} : readContent(input.format ?? campaign.format, input.content);
		const segments = await readSegmentChanges(account, campaign.newsletterId, input);
		const tierChanges = await readTierChanges(account, campaign, input);
		const set = {
			...(input.subject !== undefined && { subject: input.subject }),
			...(input.previewText !== undefined && { previewText: input.previewText }),
			...(input.fromName && { fromName: input.fromName }),
			...(input.publishTo && toPublishFields(input.publishTo)),
			...(input.audience !== undefined && { audience: input.audience }),
			...tierChanges.set,
			...(await (await import("@/lib/authors")).authorChanges(account, campaign.newsletterId, input.authorId)),
			...(input.tags !== undefined && readTags(input.tags)),
			...content,
			...(thumbnailUrl && { thumbnailUrl }),
			...(campaign.kind === "note" && { ...shortPostFields({ ...campaign, ...content }), ...toPublishFields("web"), audience: "all" }),
			...segments.set,
			...(await campaignListChanges(account, campaign.newsletterId, input, campaign)),
			...(input.abTest && { abTest: toAbTestDraft(input.abTest, { ...campaign, ...pickDefined(input, ["subject", "previewText"]) }) }),
		};
		const unset = {
			...(input.content !== undefined && !thumbnailUrl && { thumbnailUrl: 1 }),
			...segments.unset,
			...tierChanges.unset,
			...(input.abTest === null && { abTest: 1 }),
			...(input.fromName === "" && { fromName: 1 }),
		};
		if (["subject", "previewText", "format", "html", "markdown"].some(key => Object.hasOwn(set, key))) set.editorResetId = randomUUID();
		if (Object.keys(set).length === 0 && Object.keys(unset).length === 0) return reload(account, campaign);
		await recordVersion(account, campaign, { changes: pickDefined(set, ["subject", "previewText", "format", "html", "markdown"]) });
		// The status check is part of the write, so a change can't land on a campaign that just started sending.
		const { matchedCount } = await Campaign.updateOne(scoped(account, { _id: campaign._id, status: { $in: EDITABLE_STATUSES }, ...(input.expectedContentHash && campaignContentCondition(campaign)) }), {
			...(Object.keys(set).length > 0 && { $set: set }),
			...(Object.keys(unset).length > 0 && { $unset: unset }),
		});
		if (!matchedCount) throw actionError("conflict", "This campaign is already sending");
		return reload(account, campaign);
	},
});

const deleteCampaign = defineAction({
	name: "delete_campaign",
	tryWithoutPlan: true,
	title: "Delete a draft campaign",
	group: GROUP,
	description:
		"Deletes a draft or scheduled campaign: it leaves every list and a scheduled send never goes out. Sent campaigns can't be deleted.",
	http: { method: "DELETE", path: "/campaigns/{id}" },
	destructive: true,
	idempotent: true,
	whileBlocked: true,
	input: z.object({ id: campaignId }),
	output: z.object({ id: z.string(), deleted: z.literal(true) }),
	handler: async ({ account, input }) => {
		const campaign = await findCampaign(account, input.id);
		assertEditable(campaign, "Only drafts can be deleted");
		// Kept in the database as canceled, like every customer document.
		const { matchedCount } = await Campaign.updateOne(scoped(account, { _id: campaign._id, status: { $in: EDITABLE_STATUSES } }), {
			$set: { status: "canceled" },
			$unset: { scheduledAt: 1 },
		});
		if (!matchedCount) throw actionError("conflict", "This campaign is already sending");
		// A discarded resend leaves its campaign free to be resent.
		if (isResend(campaign)) await Campaign.updateOne(scoped(account, { _id: campaign.resend.of, resentAs: campaign._id }), { $unset: { resentAs: 1 } });
		await deleteAudioOfCampaign(account, campaign._id);
		return { id: String(campaign._id), deleted: true };
	},
});

const duplicateCampaign = defineAction({
	name: "duplicate_campaign",
	tryWithoutPlan: true,
	title: "Duplicate a campaign",
	group: GROUP,
	description: "Copies a campaign's subject, preview text, sender name, content, segment and subject line test into a new draft.",
	http: { method: "POST", path: "/campaigns/{id}/duplicate", status: 201 },
	rateLimit: { limit: 60, window: "1 h" },
	input: z.object({ id: campaignId }),
	output: CampaignSchema,
	handler: async ({ account, input, via }) => {
		const campaign = await findCampaign(account, input.id);
		const maxSubject = 200 - COPY_SUFFIX.length;
		const copy = await Campaign.create({
			accountId: account._id,
			newsletterId: campaign.newsletterId,
			kind: campaign.kind ?? "issue",
			subject: campaign.subject ? `${campaign.subject.slice(0, maxSubject)}${COPY_SUFFIX}` : "",
			previewText: campaign.previewText,
			...(campaign.kind === "note" && shortPostFields(campaign)),
			...(await (await import("@/lib/authors")).copyIssueAuthor(account, campaign)),
			...(campaign.fromName && { fromName: campaign.fromName }),
			...(campaign.publishTo && toPublishFields(campaign.publishTo)),
			format: campaign.format,
			markdown: campaign.markdown,
			html: campaign.html,
			internalLinks: readIssueLinkRefs(campaign.html),
			internalLinkIds: readIssueLinkRefs(campaign.html).map(({ id }) => id),
			thumbnailUrl: campaign.thumbnailUrl,
			...(campaign.listIds && { listIds: campaign.listIds }),
			...(campaign.excludeListIds && { excludeListIds: campaign.excludeListIds }),
			...(campaign.segmentId && { segmentId: campaign.segmentId }),
			...(campaign.segmentIds?.length && { segmentIds: campaign.segmentIds }),
			...(campaign.excludeSegmentIds?.length && { excludeSegmentIds: campaign.excludeSegmentIds }),
			...(hasAbTest(campaign) && {
				abTest: toAbTestDraft(
					{ ...campaign.abTest, subjects: campaign.abTest.variants.slice(1).map(({ subject, previewText }) => ({ subject, previewText })) },
					campaign
				),
			}),
			// A copy of an API draft is still content from the API key's holder, not from the dashboard.
			...((campaign.source === "api" || via !== "dashboard") && { source: "api" }),
		});
		return reload(account, copy);
	},
});

const MAX_TEST_RECIPIENTS = 10;

const sendTest = defineAction({
	name: "send_test_email",
	title: "Send a test email",
	group: GROUP,
	description: `Sends the campaign as saved, subject prefixed with [Test], to the account owner's address or to up to ${MAX_TEST_RECIPIENTS} addresses of your choosing, each its own email. Nobody on the list gets it. Each one counts toward the plan's emails; addresses that bounced, complained or can't receive email are skipped.`,
	http: { method: "POST", path: "/campaigns/{id}/test" },
	openWorld: true,
	rateLimit: { limit: 30, window: "1 h" },
	example: { to: ["editor@example.com", "jane@example.com"] },
	input: z.object({
		id: campaignId,
		to: z
			.array(z.string().trim().toLowerCase().max(254).email("Each address must be an email address"))
			.min(1)
			.max(MAX_TEST_RECIPIENTS)
			.optional()
			.describe(`Up to ${MAX_TEST_RECIPIENTS} addresses. Default: the account owner's.`),
	}),
	output: z.object({
		sentTo: z.string().describe("The first address it went to"),
		messageId: z.string(),
		recipients: z.array(z.object({ email: z.string(), messageId: z.string() })),
		skipped: z.array(z.object({ email: z.string(), reason: z.string() })),
	}),
	handler: async ({ account, user, input }) => {
		const campaign = await findCampaign(account, input.id);
		if (campaign.kind === "note") throw actionError("validation_failed", "A short post publishes on the web. Use its web preview instead of a test email.");
		assertSendingEnabled();
		const to = input.to ?? [await findTestRecipient({ account, user })];
		const { sent, skipped } = await sendTestEmail({ accountId: account._id, campaignId: String(campaign._id), to });
		if (sent.length === 0) throw actionError("send_check_failed", `${skipped.map(({ email }) => email).join(", ")} can't receive email`);
		return { sentTo: sent[0].email, messageId: sent[0].messageId, recipients: sent, skipped };
	},
});

const scheduleCampaign = defineAction({
	name: "schedule_campaign",
	title: "Schedule a campaign",
	group: GROUP,
	description: `Schedules a draft to send by itself at a time within a year. It goes out without asking again, unless unschedule_campaign runs first. ${IRREVERSIBLE} Plan limits and pre-send checks run now and again when it goes out. ${HOW_IT_GOES_OUT}`,
	http: { method: "POST", path: "/campaigns/{id}/schedule" },
	destructive: true,
	idempotent: true,
	openWorld: true,
	rateLimit: { limit: 30, window: "1 h" },
	example: { scheduledAt: "2026-10-20T09:00:00Z" },
	input: z.object({
		id: campaignId,
		scheduledAt: z.string().max(40).describe("ISO 8601 date and time, e.g. 2026-10-20T09:00:00Z, at least a minute ahead"),
		audience: audienceInput.optional().describe("Who gets it: all, free or paid readers. Default: the campaign's own audience (see create_campaign)."),
		audienceLimit: audienceLimitInput,
	}),
	output: CampaignSchema,
	handler: async ({ account, input }) => {
		const campaign = await findCampaign(account, input.id);
		if (!EDITABLE_STATUSES.includes(campaign.status)) throw statusConflict(campaign);
		if (campaign.kind === "note") assertShortPostInput(input);
		assertSendingEnabled();
		const at = new Date(input.scheduledAt);
		const problem = getScheduleProblem(at);
		if (problem) throw actionError("validation_failed", problem);
		const newsletter = await findCampaignNewsletter(account, campaign);
		await assertCanSend(account, campaign, newsletter);
		const limit = readPositiveInteger(input.audienceLimit);
		await assertAudienceAllowed(account, campaign, input.audience);
		if (campaign.publishTo !== "web") await checkCampaignSend({ accountId: account._id, campaignId: campaign._id, audienceLimit: limit, audience: input.audience, at });

		const { matchedCount } = await Campaign.updateOne(scoped(account, { _id: campaign._id, status: { $in: EDITABLE_STATUSES } }), {
			$set: { status: "scheduled", scheduledAt: at, ...(limit && { audienceLimit: limit }), ...(input.audience && { audience: input.audience }) },
			...((!limit || isLeavingPaid(input.audience)) && { $unset: { ...(!limit && { audienceLimit: 1 }), ...(isLeavingPaid(input.audience) && { audienceMinTier: 1, audienceTiers: 1 }) } }),
		});
		if (!matchedCount) throw actionError("conflict", "The campaign changed, refresh and try again");

		try {
			await publishScheduledSend({ accountId: account._id, campaignId: campaign._id, scheduledAt: at });
		} catch (error) {
			console.error("[campaigns] Scheduling failed:", error);
			const previous =
				campaign.status === "scheduled"
					? { $set: { status: "scheduled", scheduledAt: campaign.scheduledAt } }
					: { $set: { status: "draft" }, $unset: { scheduledAt: 1 } };
			await Campaign.updateOne(scoped(account, { _id: campaign._id, status: "scheduled", scheduledAt: at }), previous);
			throw actionError("unavailable", `Couldn't schedule it: ${error.message}`);
		}

		const when = `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
		await notifySend(account, campaign, `Send scheduled for ${when}${limit ? ` (first ${formatNumber(limit)})` : ""}`);
		return reload(account, campaign);
	},
});

const unscheduleCampaign = defineAction({
	name: "unschedule_campaign",
	tryWithoutPlan: true,
	title: "Cancel a scheduled send",
	group: GROUP,
	description: "Turns a scheduled campaign back into a draft, so it doesn't go out.",
	http: { method: "POST", path: "/campaigns/{id}/unschedule" },
	idempotent: true,
	whileBlocked: true,
	input: z.object({ id: campaignId }),
	output: CampaignSchema,
	handler: async ({ account, input }) => {
		const campaign = await findCampaign(account, input.id);
		const { matchedCount } = await Campaign.updateOne(scoped(account, { _id: campaign._id, status: "scheduled" }), {
			$set: { status: "draft" },
			$unset: { scheduledAt: 1 },
		});
		if (!matchedCount && campaign.status !== "draft") throw actionError("conflict", "It isn't scheduled anymore");
		return reload(account, campaign);
	},
});

// A draft is held when the newsletter has an undo window and the issue goes out as email: a web only issue publishes at once,
// and a scheduled one has its own time. Returns whether it is held.
async function holdSend(account, campaign, { limit, audience }) {
	const newsletter = await findCampaignNewsletter(account, campaign);
	const seconds = getUndoSeconds(newsletter);
	if (seconds === 0 || campaign.status !== "draft" || campaign.publishTo === "web") return false;
	await holdCampaignSend({
		account,
		campaign,
		seconds,
		audienceLimit: limit,
		audience,
		set: { ...(limit && { audienceLimit: limit }), ...(audience && { audience }) },
		unset: { ...(!limit && { audienceLimit: 1 }), ...(isLeavingPaid(audience) && { audienceMinTier: 1, audienceTiers: 1 }) },
	});
	return true;
}

async function sendHeldNow(account, campaign) {
	assertSendingEnabled();
	const result = await releaseCampaign({ accountId: account._id, campaignId: campaign._id });
	if (!result) throw actionError("conflict", "This send is already going out");
	await notifySend(account, campaign, "Send started");
	return reload(account, campaign);
}

const undoCampaignSend = defineAction({
	name: "undo_campaign_send",
	tryWithoutPlan: true,
	title: "Undo a held send",
	group: GROUP,
	description:
		"Takes back a send the dashboard is holding for its undo window (status held): the campaign goes back to a draft exactly as it was, with nothing queued, counted or emailed. Answers conflict once the send went out.",
	http: { method: "POST", path: "/campaigns/{id}/undo-send" },
	idempotent: true,
	whileBlocked: true,
	input: z.object({ id: campaignId }),
	output: CampaignSchema,
	handler: async ({ account, input }) => {
		const campaign = await findCampaign(account, input.id);
		await undoHeldSend({ account, campaign });
		return reload(account, campaign);
	},
});

const sendCampaign = defineAction({
	name: "send_campaign",
	title: "Send a campaign now",
	group: GROUP,
	description: `Sends a draft or scheduled campaign now to the newsletter's active contacts, to the campaign's segment (update_campaign) or to its free or paid readers only (audience), most engaged first. ${IRREVERSIBLE} A campaign that is already sending or sent answers conflict, so a retry never sends twice. Plan limits, the from address, the postal address and the email size are checked first. A web only campaign (publishTo web) is published on the website instead, with no email. ${HOW_IT_GOES_OUT}`,
	http: { method: "POST", path: "/campaigns/{id}/send" },
	destructive: true,
	openWorld: true,
	rateLimit: { limit: 30, window: "1 h" },
	input: z.object({
		id: campaignId,
		audience: audienceInput.optional().describe("Who gets it: all, free or paid readers. Default: the campaign's own audience (see create_campaign)."),
		audienceLimit: audienceLimitInput,
	}),
	// The dashboard's Send waits for the newsletter's undo window (undo_campaign_send); the API and MCP send at once.
	dashboardInput: z.object({ holdForUndo: z.boolean().optional() }),
	output: CampaignSchema,
	handler: async ({ account, input }) => {
		const campaign = await findCampaign(account, input.id);
		// Send now on a send that is waiting for its undo window skips the wait. The dashboard's Send pressed again does not:
		// a double click must not take the window away.
		if (campaign.status === "held") return input.holdForUndo ? reload(account, campaign) : sendHeldNow(account, campaign);
		if (campaign.kind === "note") assertShortPostInput(input);
		if (!EDITABLE_STATUSES.includes(campaign.status)) throw statusConflict(campaign);
		assertSendingEnabled();
		await assertCanSend(account, campaign, await findCampaignNewsletter(account, campaign));
		await assertAudienceAllowed(account, campaign, input.audience);

		const limit = readPositiveInteger(input.audienceLimit);
		if (input.holdForUndo && (await holdSend(account, campaign, { limit, audience: input.audience }))) return reload(account, campaign);
		const { matchedCount } = await Campaign.updateOne(scoped(account, { _id: campaign._id, status: { $in: EDITABLE_STATUSES } }), {
			...((limit || input.audience) && { $set: { ...(limit && { audienceLimit: limit }), ...(input.audience && { audience: input.audience }) } }),
			...((!limit || isLeavingPaid(input.audience)) && { $unset: { ...(!limit && { audienceLimit: 1 }), ...(isLeavingPaid(input.audience) && { audienceMinTier: 1, audienceTiers: 1 }) } }),
		});
		if (!matchedCount) throw actionError("conflict", "This campaign is already sending");
		await queueCampaign({ accountId: account._id, campaignId: String(campaign._id) });
		// Sending a scheduled campaign now replaces its schedule; the job left in QStash then does nothing.
		await Campaign.updateOne(scoped(account, { _id: campaign._id }), { $unset: { scheduledAt: 1 } });
		revalidateArchive();
		await notifySend(account, campaign, limit ? `Send started (first ${formatNumber(limit)})` : "Send started");
		return reload(account, campaign);
	},
});

const sendCampaignToMore = defineAction({
	name: "send_campaign_to_more",
	title: "Send a campaign to more contacts",
	group: GROUP,
	description: `Sends a sent campaign to contacts who haven't received it yet, the next most engaged first: a send in steps. ${IRREVERSIBLE} Each call starts a new step, so check get_campaign_report before calling it again; while a step is still sending it answers conflict. ${HOW_IT_GOES_OUT}`,
	http: { method: "POST", path: "/campaigns/{id}/send-more" },
	destructive: true,
	openWorld: true,
	rateLimit: { limit: 30, window: "1 h" },
	example: { additional: 2000 },
	input: z.object({
		id: campaignId,
		additional: z
			.number()
			.int()
			.min(1)
			.max(10_000_000)
			.optional()
			.describe("How many more contacts. Default: everyone who hasn't received it."),
	}),
	output: CampaignSchema.extend({ added: z.number().int().describe("Contacts this step adds") }),
	handler: async ({ account, input }) => {
		const campaign = await findCampaign(account, input.id);
		if (campaign.status !== "sent") {
			throw actionError("conflict", campaign.status === "sending" ? "Wait until the current step has gone out" : "Only sent campaigns can go to more contacts");
		}
		assertSendingEnabled();
		await assertCanSend(account, campaign, await findCampaignNewsletter(account, campaign));
		const more = readPositiveInteger(input.additional);
		const { added } = await sendToMoreContacts({ accountId: account._id, campaignId: String(campaign._id), additional: more });
		await notifySend(account, campaign, `Send to more started (${more ? `next ${formatNumber(more)}` : "everyone left"})`);
		return { ...(await reload(account, campaign)), added };
	},
});

const HOUR_MS = 3_600_000;

// RESEND_DELAY_HOURS after the first send by default, or in a few minutes when that's past.
function getResendTime(campaign, scheduledAt) {
	if (scheduledAt) return new Date(scheduledAt);
	const later = new Date(campaign.sentAt ?? campaign.startedAt ?? Date.now()).getTime() + RESEND_DELAY_HOURS * HOUR_MS;
	return new Date(Math.max(later, Date.now() + 5 * 60_000));
}

const resendCampaign = defineAction({
	name: "resend_campaign",
	title: "Resend a campaign to readers who didn't open it",
	group: GROUP,
	description: `Schedules a copy of a sent campaign, with a new subject, for the readers it reached who didn't open it (or didn't click), ${RESEND_DELAY_HOURS} hours after it went out unless scheduledAt says otherwise. ${IRREVERSIBLE} The copy is a scheduled campaign of its own, with its own report; unschedule_campaign stops it. Readers who unsubscribed, bounced or complained since, and anyone the campaign's audience no longer has, are left out. One resend per campaign; its emails count toward the plan like any send.`,
	http: { method: "POST", path: "/campaigns/{id}/resend" },
	destructive: true,
	openWorld: true,
	rateLimit: { limit: 30, window: "1 h" },
	example: { subject: "In case you missed it: this week", to: "unopened" },
	input: z.object({
		id: campaignId,
		subject: subjectInput.min(1, "Add a subject").describe("The resend's subject, 200 characters at most: a new one does better than the same twice"),
		previewText: previewTextInput.optional().describe("Default: the campaign's own"),
		to: z.enum(RESEND_TARGETS).optional().describe("unopened (the default): readers who didn't open it. unclicked: readers who didn't click a link, opened or not."),
		scheduledAt: z
			.string()
			.max(40)
			.optional()
			.describe(`ISO 8601 date and time, at least a minute ahead. Default: ${RESEND_DELAY_HOURS} hours after the campaign went out.`),
	}),
	output: CampaignSchema,
	handler: async ({ account, input, via }) => {
		const original = await findCampaign(account, input.id);
		if (original.status !== "sent") throw actionError("conflict", "Only a campaign that went out can be resent, once it's done sending");
		if (isResend(original)) throw actionError("conflict", "A resend can't be resent");
		if (original.publishTo === "web") throw actionError("conflict", "This issue was published on the web only");
		if (original.resentAs) throw actionError("conflict", "This campaign was resent already: one resend per campaign");
		if (original.abTest?.status === "testing") throw actionError("conflict", "Wait for the subject line test's winner first");
		assertSendingEnabled();
		const at = getResendTime(original, input.scheduledAt);
		const problem = getScheduleProblem(at);
		if (problem) throw actionError("validation_failed", problem);

		const copy = {
			accountId: account._id,
			newsletterId: original.newsletterId,
			subject: input.subject,
			previewText: input.previewText ?? original.previewText,
			...(original.fromName && { fromName: original.fromName }),
			format: original.format,
			markdown: original.markdown,
			html: original.html,
			thumbnailUrl: original.thumbnailUrl,
			audience: original.audience ?? "all",
			...(original.listIds && { listIds: original.listIds }),
			...(original.excludeListIds && { excludeListIds: original.excludeListIds }),
			...(original.segmentId && { segmentId: original.segmentId }),
			...(original.segmentIds?.length && { segmentIds: original.segmentIds }),
			...(original.excludeSegmentIds?.length && { excludeSegmentIds: original.excludeSegmentIds }),
			...(original.segmentSnapshot && { segmentSnapshot: original.segmentSnapshot }),
			archiveListed: original.archiveListed !== false,
			resend: { of: original._id, to: input.to ?? "unopened", ...(original.archiveSlug && { slug: original.archiveSlug }) },
			status: "scheduled",
			scheduledAt: at,
			source: via === "dashboard" ? "dashboard" : "api",
		};
		const newsletter = await findCampaignNewsletter(account, original);
		// The plan's room is checked when it goes out, like any scheduled send's after the month starts over.
		await assertCanSend(account, copy, newsletter);

		// The claim on the campaign comes first, so two calls can't both make a resend.
		const resend = { ...copy, _id: new ObjectId() };
		const { modifiedCount } = await Campaign.updateOne(scoped(account, { _id: original._id, resentAs: { $exists: false } }), { $set: { resentAs: resend._id } });
		if (!modifiedCount) throw actionError("conflict", "This campaign was resent already: one resend per campaign");
		try {
			await Campaign.create(resend);
			await publishScheduledSend({ accountId: account._id, campaignId: resend._id, scheduledAt: at });
		} catch (error) {
			console.error("[campaigns] Resend not scheduled:", error);
			await Campaign.updateOne(scoped(account, { _id: resend._id }), { $set: { status: "canceled" }, $unset: { scheduledAt: 1 } });
			await Campaign.updateOne(scoped(account, { _id: original._id, resentAs: resend._id }), { $unset: { resentAs: 1 } });
			throw actionError("unavailable", `Couldn't schedule the resend: ${error.message}`);
		}
		const when = `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
		await notifySend(account, resend, `Resend to readers who didn't ${copy.resend.to === "unclicked" ? "click" : "open"} scheduled for ${when}`);
		return reload(account, resend);
	},
});

const pauseCampaign = defineAction({
	name: "pause_campaign",
	title: "Pause a campaign",
	group: GROUP,
	description: "Stops a campaign that is sending. Emails already sent stay sent; the rest wait until resume_campaign.",
	http: { method: "POST", path: "/campaigns/{id}/pause" },
	idempotent: true,
	whileBlocked: true,
	input: z.object({ id: campaignId }),
	output: CampaignSchema,
	handler: async ({ account, input }) => {
		const campaign = await findCampaign(account, input.id);
		if (campaign.status === "sending") {
			await Campaign.updateOne(scoped(account, { _id: campaign._id, status: "sending" }), { $set: { status: "paused" } });
		} else if (campaign.status !== "paused") {
			throw actionError("conflict", "Only a campaign that is sending can pause");
		}
		return reload(account, campaign);
	},
});

const resumeCampaign = defineAction({
	name: "resume_campaign",
	title: "Resume a paused campaign",
	group: GROUP,
	description: `Sends the rest of a paused campaign. ${IRREVERSIBLE} The plan limits and the account's state are checked again first. Resumed after a high_rates or first_send_slice pause, only the block level stops it again.`,
	http: { method: "POST", path: "/campaigns/{id}/resume" },
	destructive: true,
	openWorld: true,
	rateLimit: { limit: 30, window: "1 h" },
	input: z.object({ id: campaignId }),
	output: CampaignSchema,
	handler: async ({ account, input }) => {
		const campaign = await findCampaign(account, input.id);
		if (campaign.status !== "paused") throw actionError("conflict", "Only paused campaigns can resume");
		assertSendingEnabled();
		await queueCampaign({ accountId: account._id, campaignId: String(campaign._id) });
		await notifySend(account, campaign, "Send resumed");
		return reload(account, campaign);
	},
});

const previewCampaignRecipients = defineAction({
	name: "preview_campaign_recipients",
	tryWithoutPlan: true,
	title: "Preview who a campaign goes to",
	group: GROUP,
	description:
		"Counts the contacts a send of the campaign would reach if it went out now, and shows the first few: the active contacts of its audience (all, free or paid) that are in its segment, or all the newsletter's, with suppressed addresses out. It also counts the emails it would use from the plan (the list cleanup's last-chance emails included) and whether they fit. Reads the whole list when the list cleanup is on, so it can take a few seconds.",
	http: { method: "GET", path: "/campaigns/{id}/recipients" },
	readOnly: true,
	rateLimit: { limit: 30, window: "1 h" },
	input: z.object({
		id: campaignId,
		audienceLimit: audienceLimitInput.describe("Count for a send capped at this many contacts"),
		sample: z.number().int().min(0).max(50).optional().describe("How many of the most engaged recipients to list, 10 by default"),
	}),
	output: z.object({
		segment: z.object({ id: z.string(), name: z.string() }).nullable(),
		audience: z.number().int().describe("Active contacts it would reach, before the list cleanup and the audience limit"),
		recipients: z.number().int().describe("Contacts that would get the issue itself: the audience after the list cleanup and the audience limit"),
		lastChance: z.number().int().describe("Cold contacts that would get the list cleanup's last-chance email instead. 0 when the cleanup is off."),
		emails: z.number().int().describe("Emails the send would use from the plan"),
		emailsLeft: z.number().int().nullable().describe("Emails the plan has left this month, minus those other sends still have to send. null: no limit."),
		fitsPlan: z.boolean(),
		sample: z.array(z.object({ email: z.string(), status: z.string() })).describe("The most engaged recipients, who a warm-up send reaches first"),
	}),
	handler: async ({ account, input }) => {
		const campaign = await findCampaign(account, input.id);
		const [segment, filter, cleanup] = await Promise.all([
			findCampaignSegment(account, campaign),
			getCampaignAudienceFilter(campaign, { audience: campaign.audience ?? "all" }),
			getCleanupPreview({ accountId: account._id, campaignId: campaign._id }),
		]);
		if (hasSegments(campaign) && !segment) throw actionError("conflict", "This campaign's segment was deleted: pick another audience");
		const limit = readPositiveInteger(input.audienceLimit);
		const audience = await Contact.countDocuments(filter);
		const counted = cleanup.enabled ? summarizePreview({ ...cleanup }, limit) : null;
		const recipients = counted ? counted.issue : Math.min(audience, limit ?? Infinity);
		const lastChance = counted?.lastChance ?? 0;
		const emails = recipients + lastChance;
		const [usage, inFlight, people] = await Promise.all([
			getUsage(account),
			countEmailsInFlight(account._id),
			input.sample === 0 ? [] : Contact.find(filter).sort(AUDIENCE_SORT).limit(input.sample ?? 10).select({ email: 1, status: 1 }).lean(),
		]);
		const emailsLeft = usage.emailsLimit === null ? null : Math.max(0, usage.emailsLimit + usage.extraEmailsLimit - usage.emailsSent - inFlight);
		return {
			segment,
			audience,
			recipients,
			lastChance,
			emails,
			emailsLeft,
			fitsPlan: emailsLeft === null || emails <= emailsLeft,
			sample: people.map(({ email, status }) => ({ email, status })),
		};
	},
});

const updateCampaignArchive = defineAction({
	name: "update_campaign_archive",
	tryWithoutPlan: true,
	title: "Update a campaign's archive page",
	group: GROUP,
	description:
		"Changes the path of a campaign's archive page (/p/<slug>), lists or unlists it on the website, pins a sent issue to the top of the archive, changes its tags, or sets what search engines and social cards show for it: an SEO title, a meta description and a social image over the subject, the preview text and the first picture (empty clears one), and noindex, which asks search engines to leave the page out and takes it out of the sitemap and llms.txt. Works on drafts and on sent campaigns.",
	http: { method: "PATCH", path: "/campaigns/{id}/archive" },
	idempotent: true,
	example: { pinned: true },
	input: z.object({
		id: campaignId,
		slug: z.string().max(120).optional().describe("Lowercase letters, digits and dashes. Empty removes it from a draft."),
		pinned: z.boolean().optional().describe("Pinned issues lead the archive"),
		tags: tagsInput.optional().describe("Replaces the issue's tags, on a sent issue too"),
		listed: z
			.boolean()
			.optional()
			.describe("In the website's list of issues and its feed. An unlisted issue keeps its page at its link, and its emails have no read online link. An email only issue has no page to list."),
		seoTitle: z.string().trim().max(SEO_LIMITS.title).optional().describe(`The page's title for search engines and social cards, ${SEO_LIMITS.title} characters at most; about 60 show in results. Empty uses the subject.`),
		seoDescription: z.string().trim().max(SEO_LIMITS.description).optional().describe(`The meta description, ${SEO_LIMITS.description} characters at most; about 155 show in results. Empty uses the preview text.`),
		socialImage: z.string().trim().max(SEO_LIMITS.image).optional().describe("The picture of the social card: an https:// link, 1200×630 works best. Empty uses the issue's first picture, else a generated card."),
		noindex: z.boolean().optional().describe("Ask search engines to leave the page out of their results, and leave it out of the sitemap and llms.txt. The page still works at its link."),
	}),
	output: CampaignSchema,
	handler: async ({ account, input }) => {
		const campaign = await findCampaign(account, input.id);
		if (input.slug !== undefined) await setArchiveSlug(account, campaign, input.slug);
		if (input.listed !== undefined && input.listed !== (campaign.archiveListed !== false)) {
			if (campaign.publishTo === "email") throw actionError("conflict", "An email only issue has no web page to list");
			await Campaign.updateOne(scoped(account, { _id: campaign._id }), { $set: { archiveListed: input.listed }, ...(!input.listed && { $unset: { archivePinned: 1 } }) });
			revalidateArchive();
		}
		if (input.tags !== undefined) {
			await Campaign.updateOne(scoped(account, { _id: campaign._id }), { $set: readTags(input.tags) });
			revalidateArchive();
		}
		if (input.pinned !== undefined && input.pinned !== Boolean(campaign.archivePinned)) {
			const current = await Campaign.findOne(scoped(account, { _id: campaign._id })).select({ archiveSlug: 1, archiveListed: 1 }).lean();
			if (!current.archiveSlug || current.archiveListed === false) throw actionError("conflict", "Not listed on the archive");
			await Campaign.updateOne(scoped(account, { _id: campaign._id }), { $set: { archivePinned: input.pinned } });
			revalidateArchive();
		}
		await setSeo(account, campaign, input);
		return reload(account, campaign);
	},
});

// The issue's search settings: a field passed empty is cleared, one not passed stays. The change is dated for the sitemap.
export async function setSeo(account, campaign, input) {
	const fields = { title: input.seoTitle, description: input.seoDescription, imageUrl: input.socialImage, noindex: input.noindex };
	const changes = Object.entries(fields).filter(([key, value]) => value !== undefined && value !== (key === "noindex" ? Boolean(campaign.seo?.noindex) : (campaign.seo?.[key] ?? "")));
	if (changes.length === 0) return;
	const problem = getSeoProblem({ title: input.seoTitle, description: input.seoDescription, image: input.socialImage });
	if (problem) throw actionError("validation_failed", problem);
	const set = { "seo.updatedAt": new Date() };
	const unset = {};
	for (const [key, value] of changes) {
		if (value === "" || value === false) unset[`seo.${key}`] = 1;
		else set[`seo.${key}`] = value;
	}
	await Campaign.updateOne(scoped(account, { _id: campaign._id }), { $set: set, ...(Object.keys(unset).length > 0 && { $unset: unset }) });
	if (PUBLISHED_STATUSES.includes(campaign.status)) revalidateArchive();
}

const previewCampaignCleanup = defineAction({
	name: "preview_campaign_cleanup",
	tryWithoutPlan: true,
	title: "Preview the list cleanup of a send",
	group: GROUP,
	description:
		"Counts what the newsletter's list cleanup would do if the campaign went out now: issues sent, last-chance emails instead, contacts still waiting to answer one, and contacts made dormant. Reads the whole list, so it can take a few seconds.",
	http: { method: "GET", path: "/campaigns/{id}/cleanup-preview" },
	readOnly: true,
	rateLimit: { limit: 30, window: "1 h" },
	input: z.object({
		id: campaignId,
		audienceLimit: audienceLimitInput.describe("Count for a send capped at this many contacts"),
		includeRanks: z
			.boolean()
			.optional()
			.describe("Also return, for each cold contact, how many issue recipients come before it, to recount any limit without asking again"),
	}),
	output: z.object({
		enabled: z.boolean().describe("False when the newsletter's list cleanup is off; the counts are null then"),
		issue: z.number().int().nullable(),
		lastChance: z.number().int().nullable(),
		waiting: z.number().int().nullable(),
		dormant: z.number().int().nullable(),
		ranks: z
			.object({
				issue: z.number().int(),
				lastChance: z.array(z.number().int()),
				waiting: z.array(z.number().int()),
				dormant: z.array(z.number().int()),
			})
			.optional(),
	}),
	handler: async ({ account, input }) => {
		const campaign = await findCampaign(account, input.id);
		const preview = await getCleanupPreview({ accountId: account._id, campaignId: campaign._id });
		if (!preview.enabled) return { enabled: false, issue: null, lastChance: null, waiting: null, dormant: null };
		const { enabled, ...ranks } = preview;
		return { enabled, ...summarizePreview(ranks, input.audienceLimit), ...(input.includeRanks && { ranks }) };
	},
});

export const campaignActions = [
	listCampaigns,
	getCampaign,
	getCampaignReport,
	listLinkClicks,
	createCampaign,
	updateCampaign,
	deleteCampaign,
	duplicateCampaign,
	sendTest,
	scheduleCampaign,
	unscheduleCampaign,
	sendCampaign,
	undoCampaignSend,
	sendCampaignToMore,
	resendCampaign,
	pauseCampaign,
	resumeCampaign,
	updateCampaignArchive,
	previewCampaignCleanup,
	previewCampaignRecipients,
];
