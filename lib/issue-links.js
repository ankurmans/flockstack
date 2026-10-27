import "server-only";
import { scoped } from "@/lib/account-scope";
import { getIssuePageUrl } from "@/lib/archive-data";
import { readIssueLinkRefs, sameIssueUrl } from "@/lib/issue-link-rules";
import Campaign from "@/models/Campaign";
const dto = (campaign, newsletter) => ({ id: String(campaign._id), title: campaign.subject ?? "", status: campaign.status, url: campaign.publishTo === "email" || campaign.resend?.of ? null : getIssuePageUrl({ campaign, newsletter }) });
export async function getIssueLinks(account, newsletter, campaign) {
	const refs = readIssueLinkRefs(campaign.html);
	const base = scoped(account, { newsletterId: newsletter._id, status: { $ne: "canceled" } });
	const [targets, sources, unindexedIssues] = await Promise.all([
		refs.length ? Campaign.find({ ...base, _id: { $in: refs.map(({ id }) => id) } }).select("subject status archiveSlug publishTo resend").lean() : [],
		Campaign.find({ ...base, internalLinkIds: String(campaign._id) }).sort({ updatedAt: -1, _id: -1 }).limit(51).select("subject status archiveSlug publishTo resend internalLinks").lean(),
		Campaign.countDocuments({ ...base, internalLinks: { $exists: false } }),
	]);
	const ownUrl = getIssuePageUrl({ campaign, newsletter });
	return { outgoing: targets.filter((target) => target.publishTo !== "email" && !target.resend?.of && refs.some((ref) => ref.id === String(target._id) && sameIssueUrl(ref.href, getIssuePageUrl({ campaign: target, newsletter })))).map((target) => dto(target, newsletter)), incoming: sources.slice(0, 50).filter((source) => (source.internalLinks ?? []).some((ref) => ref.id === String(campaign._id) && sameIssueUrl(ref.href, ownUrl))).map((source) => dto(source, newsletter)), hasMoreIncoming: sources.length > 50, unindexedIssues };
}
