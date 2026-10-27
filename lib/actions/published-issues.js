import "server-only";
import { shortPostFields } from "@/lib/short-post-rules";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import {
	CampaignSchema,
	contentInput,
	findCampaign,
	formatInput,
	pickDefined,
	previewTextInput,
	readContent,
	readTags,
	reload,
	setSeo,
	subjectInput,
	tagsInput,
} from "@/lib/actions/campaigns";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { idInput } from "@/lib/actions/shared";
import { revalidateArchive } from "@/lib/archive-data";
import { recordVersion } from "@/lib/campaign-versions";
import { SCHEMA_TYPES, SEO_LIMITS, getSeoProblem } from "@/lib/seo-rules";
import Campaign from "@/models/Campaign";

const GROUP = "Campaigns";
const campaignId = idInput("campaign");

// A sent issue's web page can change once its send is over and the issue has a page of its own. While emails are still going
// out they are made from the same words, and an email only issue or a resend has no page.
function assertWebEditable(campaign) {
	if (campaign.status !== "sent") {
		throw actionError("conflict", campaign.status === "draft" || campaign.status === "scheduled" ? "This issue hasn't been sent: update_campaign changes a draft" : `This campaign is ${campaign.status}: wait until the send is over`);
	}
	if (campaign.publishTo === "email") throw actionError("conflict", "An email only issue has no web page to edit");
	if (campaign.resend?.of) throw actionError("conflict", "A resend has no web page of its own: edit the first send");
	if (campaign.abTest?.status === "testing") throw actionError("conflict", "The subject line test is still running");
}

// Changes a sent issue's page on the website and nothing else: the title, subtitle, body, tags and search settings. The emails
// that went out are not changed, and neither are the counts, the audience or who got it. The page as it was is kept first, in
// the issue's version history (the last 30). `changes`: title, subtitle, content (with format), as the action takes them.
export async function editPublishedIssue(account, campaign, { title, subtitle, content, format, reason = "edit" }) {
	assertWebEditable(campaign);
	if (campaign.kind === "note" && (title !== undefined || subtitle !== undefined)) throw actionError("validation_failed", "A short post has no title or subtitle; edit its body");
	if (format !== undefined && content === undefined) throw actionError("validation_failed", "format: send content with it");
	if (title !== undefined && !title.trim()) throw actionError("validation_failed", "title: a sent issue needs a title");
	const { thumbnailUrl, ...body } = content === undefined ? {} : readContent(format ?? campaign.format, content);
	const set = {
		...(title !== undefined && { subject: title }),
		...(subtitle !== undefined && { previewText: subtitle }),
		...body,
		...(campaign.kind === "note" && content !== undefined && shortPostFields({ ...campaign, ...body })),
		...(thumbnailUrl && { thumbnailUrl }),
	};
	const unset = content !== undefined && !thumbnailUrl ? { thumbnailUrl: 1 } : {};
	if (Object.keys(set).length === 0) return false;
	await (await import("@/lib/sponsorship-campaigns")).assertCampaignSponsorships({ ...campaign, ...set });
	await recordVersion(account, campaign, { reason, changes: pickDefined(set, ["subject", "previewText", "format", "html", "markdown"]) });
	// The status is part of the write, so an edit can't land on an issue that went back to sending.
	const { matchedCount } = await Campaign.updateOne(scoped(account, { _id: campaign._id, status: "sent" }), {
		$set: { ...set, "seo.updatedAt": new Date() },
		...(Object.keys(unset).length > 0 && { $unset: unset }),
	});
	if (!matchedCount) throw actionError("conflict", "The campaign changed, refresh and try again");
	revalidateArchive();
	return true;
}

const updatePublishedIssue = defineAction({
	name: "update_published_issue",
	tryWithoutPlan: true,
	title: "Edit a sent issue's web page",
	group: GROUP,
	description:
		"Changes the web version of a sent issue: its title, subtitle, body, tags and search settings, and the pictures in the body. Emails already sent are not changed, and nothing else of the campaign is: not its stats, its audience or who received it. The page keeps its address and its original date in the website's list and RSS feed (the feed's entry carries the new words), and its sitemap date moves to now. The page as it was is kept in the issue's version history, the last 30 states (list_campaign_versions). Works on a sent issue that has a page, once its send is over; a draft is changed with update_campaign. A send to more contacts later (send_campaign_to_more) or a resend uses the words as they are now. An audio version made from the old words stays until it is made again.",
	http: { method: "PATCH", path: "/campaigns/{id}/published" },
	idempotent: true,
	example: { title: "This week, with a correction", content: "<p>Fixed the date.</p>", format: "rich" },
	input: z.object({
		id: campaignId,
		title: subjectInput.optional().describe("The page's title, which was the subject. 200 characters at most."),
		subtitle: previewTextInput.optional().describe("The line under the title, which was the preview text. Empty removes it."),
		format: formatInput.optional().describe("With content: the format it's in. Default: the issue's current format."),
		content: contentInput.optional(),
		tags: tagsInput.optional(),
		seoTitle: z.string().trim().max(SEO_LIMITS.title).optional().describe(`The page's title for search engines and social cards, ${SEO_LIMITS.title} characters at most. Empty uses the title.`),
		seoDescription: z.string().trim().max(SEO_LIMITS.description).optional().describe(`The meta description, ${SEO_LIMITS.description} characters at most. Empty uses the subtitle.`),
		socialImage: z.string().trim().max(SEO_LIMITS.image).optional().describe("The picture of the social card: an https:// link. Empty uses the first picture of the body."),
		noindex: z.boolean().optional().describe("Ask search engines to leave the page out of their results."),
		seoSchemaType: z.enum(SCHEMA_TYPES).optional().describe("The schema.org type of the page's structured data: BlogPosting (the default), Article or NewsArticle."),
		seoJsonLd: z.string().max(SEO_LIMITS.jsonLd).optional().describe(`This issue's own structured data as JSON (one block or up to ${SEO_LIMITS.jsonLdBlocks}, each with an @type). Empty removes it.`),
	}),
	output: CampaignSchema,
	handler: async ({ account, input }) => {
		const campaign = await findCampaign(account, input.id);
		assertWebEditable(campaign);
		if (input.format !== undefined && input.content === undefined) throw actionError("validation_failed", "format: send content with it");
		const hasSeo = [input.seoTitle, input.seoDescription, input.socialImage, input.noindex, input.seoSchemaType, input.seoJsonLd].some((value) => value !== undefined);
		if (input.tags === undefined && !hasSeo && [input.title, input.subtitle, input.content].every((value) => value === undefined)) return reload(account, campaign);
		const tags = input.tags === undefined ? null : readTags(input.tags);
		const seoProblem = hasSeo && getSeoProblem({ title: input.seoTitle, description: input.seoDescription, image: input.socialImage, schemaType: input.seoSchemaType, jsonLd: input.seoJsonLd });
		if (seoProblem) throw actionError("validation_failed", seoProblem);
		await editPublishedIssue(account, campaign, input);
		if (tags) await Campaign.updateOne(scoped(account, { _id: campaign._id }), { $set: tags });
		await setSeo(account, campaign, input);
		if (tags) revalidateArchive();
		await (await import("@/lib/record-events")).emitRecordEvent("issue.updated", { accountId: account._id, newsletterId: campaign.newsletterId, id: campaign._id });
		return reload(account, campaign);
	},
});

export const publishedIssueActions = [updatePublishedIssue];
