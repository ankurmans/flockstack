import "server-only";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { CampaignSchema, EDITABLE_STATUSES, assertEditable, findCampaign, readContent, reload } from "@/lib/actions/campaigns";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { editPublishedIssue } from "@/lib/actions/published-issues";
import { dateOutput, idInput, toIso } from "@/lib/actions/shared";
import { getVersionText, recordVersion } from "@/lib/campaign-versions";
import { countWords } from "@/lib/read-time";
import { isObjectIdString } from "@/lib/validation";
import Campaign from "@/models/Campaign";
import CampaignVersion from "@/models/CampaignVersion";

const GROUP = "Campaigns";
const campaignId = idInput("campaign");
const versionId = idInput("version");
const EXCERPT_LENGTH = 160;

const VersionSchema = z.object({
	id: z.string(),
	createdAt: dateOutput.describe("When this state was kept: the draft had these words just before it changed"),
	reason: z.enum(["autosave", "restore", "edit"]).describe("autosave: kept before an edit. restore: kept before a restore replaced it. edit: a sent issue's web page, kept before an edit to it."),
	subject: z.string(),
	previewText: z.string(),
	words: z.number().int(),
	excerpt: z.string().describe("The start of its text"),
});
const VersionDetailSchema = VersionSchema.extend({
	format: z.enum(["markdown", "rich", "html"]),
	content: z.string().describe("The body in that format"),
	text: z.string().describe("The body as plain text, for reading"),
});

function toVersion(version) {
	const text = getVersionText(version);
	return {
		id: String(version._id),
		createdAt: toIso(version.createdAt),
		reason: version.reason ?? "autosave",
		subject: version.subject ?? "",
		previewText: version.previewText ?? "",
		words: countWords(text),
		excerpt: text.replace(/\s+/g, " ").slice(0, EXCERPT_LENGTH),
	};
}

async function findVersion(account, campaign, id) {
	const version = isObjectIdString(id) ? await CampaignVersion.findOne(scoped(account, { _id: id, campaignId: campaign._id })).lean() : null;
	if (!version) throw actionError("not_found", "Version not found");
	return version;
}

const listCampaignVersions = defineAction({
	name: "list_campaign_versions",
	tryWithoutPlan: true,
	title: "List a draft's earlier versions",
	group: GROUP,
	description:
		"Lists the earlier states FlockStack kept of a draft as it was edited, newest first: at most the last 30, one every two minutes of writing. restore_campaign_version goes back to one.",
	http: { method: "GET", path: "/campaigns/{id}/versions" },
	readOnly: true,
	input: z.object({ id: campaignId }),
	output: z.object({ versions: z.array(VersionSchema) }),
	handler: async ({ account, input }) => {
		const campaign = await findCampaign(account, input.id);
		const versions = await CampaignVersion.find(scoped(account, { campaignId: campaign._id })).sort({ createdAt: -1, _id: -1 }).lean();
		return { versions: versions.map(toVersion) };
	},
});

const getCampaignVersion = defineAction({
	name: "get_campaign_version",
	tryWithoutPlan: true,
	title: "Get an earlier version of a draft",
	group: GROUP,
	description: "Gets one earlier state of a draft with its subject, preview text and content, to read before restoring it.",
	http: { method: "GET", path: "/campaigns/{id}/versions/{version}" },
	readOnly: true,
	input: z.object({ id: campaignId, version: versionId }),
	output: VersionDetailSchema,
	handler: async ({ account, input }) => {
		const campaign = await findCampaign(account, input.id);
		const version = await findVersion(account, campaign, input.version);
		return {
			...toVersion(version),
			format: version.format ?? "rich",
			content: (version.format === "markdown" ? version.markdown : version.html) ?? "",
			text: getVersionText(version),
		};
	},
});

const restoreCampaignVersion = defineAction({
	name: "restore_campaign_version",
	tryWithoutPlan: true,
	title: "Restore an earlier version of a draft",
	group: GROUP,
	description:
		"Puts a draft's subject, preview text and content back to an earlier state. The draft as it is now is kept first, so a restore can be undone by restoring that one. Works on drafts and scheduled campaigns; on a sent issue it puts the web page back (the emails that went out are not changed), as update_published_issue would.",
	http: { method: "POST", path: "/campaigns/{id}/versions/{version}/restore" },
	example: {},
	input: z.object({ id: campaignId, version: versionId }),
	output: CampaignSchema,
	handler: async ({ account, input }) => {
		const campaign = await findCampaign(account, input.id);
		// A sent issue's earlier web page comes back the way an edit of it is made (lib/actions/published-issues.js).
		if (campaign.status === "sent") {
			const earlier = await findVersion(account, campaign, input.version);
			const isMarkdown = earlier.format === "markdown";
			await editPublishedIssue(account, campaign, {
				title: earlier.subject ?? "",
				subtitle: earlier.previewText ?? "",
				format: earlier.format ?? "rich",
				content: (isMarkdown ? earlier.markdown : earlier.html) ?? "",
				reason: "restore",
			});
			return reload(account, campaign);
		}
		assertEditable(campaign, "Only drafts can be restored");
		const version = await findVersion(account, campaign, input.version);
		await recordVersion(account, campaign, { reason: "restore" });
		const { thumbnailUrl, ...content } = readContent(version.format ?? "rich", (version.format === "markdown" ? version.markdown : version.html) ?? "");
		const { matchedCount } = await Campaign.updateOne(scoped(account, { _id: campaign._id, status: { $in: EDITABLE_STATUSES } }), {
			$set: { subject: version.subject ?? "", previewText: version.previewText ?? "", ...content, ...(thumbnailUrl && { thumbnailUrl }) },
			...(!thumbnailUrl && { $unset: { thumbnailUrl: 1 } }),
		});
		if (!matchedCount) throw actionError("conflict", "This campaign is already sending");
		return reload(account, campaign);
	},
});

export const campaignVersionActions = [listCampaignVersions, getCampaignVersion, restoreCampaignVersion];
