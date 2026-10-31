import "server-only";
import { scoped } from "@/lib/account-scope";
import { getClaimState, toClaimOutput } from "@/lib/claim-check";
import { cleanRichHtml } from "@/lib/clean-html";
import { getAppUrl, isSendingEnabled } from "@/lib/config";
import { listCustomFields } from "@/lib/custom-fields";
import { splitAtPaywall } from "@/lib/editor-blocks";
import { showsSentWithLink } from "@/lib/free-plan";
import { getLinkState } from "@/lib/link-check";
import { markdownToHtml } from "@/lib/markdown";
import { getAudienceLabel } from "@/lib/tiers";
import { isOnFreeTier } from "@/lib/plans";
import { getPostalAddress } from "@/lib/postal-address";
import { buildReadyCheck, findImages, findMergeUsage } from "@/lib/ready-check";
import { renderEmail } from "@/lib/render-email";
import { getCampaignAudienceFilter, resolveCampaignSegment } from "@/lib/segments";
import { loadSender } from "@/lib/sender";
import { checkCampaignSend } from "@/lib/sending";
import { siteExtensions } from "@/lib/site-extensions";
import { countEmailsInFlight, getUsage } from "@/lib/usage";
import Contact from "@/models/Contact";
import Newsletter from "@/models/Newsletter";
import Upload from "@/models/Upload";

async function findSegmentName(campaign) {
	try {
		return { segmentName: (await resolveCampaignSegment(campaign))?.name ?? null, problem: null };
	} catch (error) {
		if (error.code === "not_found" || error.code === "conflict") return { segmentName: null, problem: error.message };
		throw error;
	}
}

// The stored sizes of the pictures the issue got from FlockStack's own uploads; pictures from other sites have no size.
async function findImageSizes(account, images) {
	const urls = [...new Set(images.map(({ src }) => src))];
	if (urls.length === 0) return new Map();
	const uploads = await Upload.find(scoped(account, { url: { $in: urls } })).select({ url: 1, bytes: 1 }).lean();
	return new Map(uploads.map(({ url, bytes }) => [url, bytes]));
}

// Of the merge tags the issue uses, how many contacts of its audience have no value for each field.
async function describeMergeTags({ account, campaign, newsletter, usage, filter }) {
	if (usage.size === 0) return [];
	const fields = new Set((await listCustomFields(account, newsletter._id)).map(({ key }) => key));
	const total = filter ? await Contact.countDocuments(filter) : 0;
	return Promise.all(
		[...usage].map(async ([name, fallback]) => {
			const isField = fields.has(name);
			const missing = isField && filter ? await Contact.countDocuments({ accountId: filter.accountId, $and: [filter, { [`fields.${name}`]: { $exists: false } }] }) : 0;
			return { name, fallback, isField, missing, total };
		})
	);
}

async function getPlanState({ account, campaign, isWebOnly }) {
	if (isWebOnly) return { planProblem: null, emails: null, emailsLeft: null };
	const [usage, inFlight] = await Promise.all([getUsage(account), countEmailsInFlight(account._id)]);
	const emailsLeft = usage.emailsLimit === null ? null : Math.max(0, usage.emailsLimit + usage.extraEmailsLimit - usage.emailsSent - inFlight);
	// The send's own refusals, in its words: the account, the plan's emails and subscribers, the Free plan's first campaigns.
	try {
		const emails = await checkCampaignSend({ accountId: account._id, campaignId: campaign._id, audienceLimit: campaign.audienceLimit });
		return { planProblem: null, emails, emailsLeft };
	} catch (error) {
		return { planProblem: error.message, emails: null, emailsLeft };
	}
}

// Everything the ready-to-send check says about a draft or scheduled campaign, with its links either checked or being checked
// (lib/link-check.js: the first call starts the job and says so, the next ones have the result).
export async function runReadyCheck({ account, campaign }) {
	const stored = await Newsletter.findOne(scoped(account, { _id: campaign.newsletterId })).lean();
	// What the email prints is the address it has or the server's default.
	const newsletter = { ...stored, postalAddress: getPostalAddress(stored, siteExtensions.defaultPostalAddress) };
	const isWebOnly = campaign.publishTo === "web";
	const sentWith = showsSentWithLink(account);
	const rendered = renderEmail({ format: campaign.format, markdown: campaign.markdown, html: campaign.html, subject: campaign.subject, previewText: campaign.previewText, newsletter, sentWith });
	const bodyHtml = campaign.format === "markdown" ? markdownToHtml(campaign.markdown ?? "") : (campaign.html ?? "");
	const images = findImages(bodyHtml);
	const filter = await getCampaignAudienceFilter(campaign, { audience: campaign.audience ?? "all" });
	const [sender, imageSizes, segment, audienceCount, plan, links, claims] = await Promise.all([
		loadSender(account, stored),
		findImageSizes(account, images),
		findSegmentName(campaign),
		filter ? Contact.countDocuments(filter) : 0,
		getPlanState({ account, campaign, isWebOnly }),
		getLinkState({ account, campaign }),
		getClaimState({ account, campaign, newsletter: stored }),
	]);
	const usage = findMergeUsage(campaign.subject, campaign.previewText, bodyHtml);
	const mergeTags = await describeMergeTags({ account, campaign, newsletter: stored, usage, filter });
	const hasPaywallBreak = campaign.format === "rich" && splitAtPaywall(cleanRichHtml(campaign.html ?? "")).hasBreak;

	const result = buildReadyCheck({
		campaign,
		newsletter,
		rendered,
		senderProblem: sender.problem ?? null,
		isSendingEnabled: isSendingEnabled(),
		planProblem: plan.planProblem,
		audience: { count: audienceCount, label: getAudienceLabel(campaign.audience ?? "all"), segmentName: segment.segmentName, problem: segment.problem },
		emailsLeft: plan.emailsLeft,
		emails: plan.emails,
		isFreePlan: isOnFreeTier(account),
		sentWith,
		images,
		imageSizes,
		mergeTags,
		links,
		claims,
		hasPaywallBreak,
	});
	return { ...result, items: result.items.map((entry) => ({ ...entry, fix: entry.fix ? { ...entry.fix, url: entry.fix.path ? `${getAppUrl()}${entry.fix.path}` : `${getAppUrl()}/campaigns/${campaign._id}` } : null })), claims: toClaimOutput(claims) };
}
