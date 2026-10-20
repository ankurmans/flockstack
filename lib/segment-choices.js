import { scoped } from "@/lib/account-scope";
import { listCustomFields } from "@/lib/custom-fields";
import CampaignLink from "@/models/CampaignLink";
import Campaign from "@/models/Campaign";
import Poll from "@/models/Poll";
import Segment from "@/models/Segment";
import Tag from "@/models/Tag";

const RECENT_ISSUES = 30;

// What the condition builder offers for a newsletter: its fields, tags, polls, the issues it sent lately with their links,
// and its saved lists. Plain values, ready to pass to a client component.
export async function loadSegmentChoices(account, newsletterId) {
	const [fields, tags, polls, campaigns, lists] = await Promise.all([
		listCustomFields(account, newsletterId),
		Tag.find(scoped(account, { newsletterId })).sort({ name: 1 }).select({ name: 1 }).lean(),
		Poll.find(scoped(account, { newsletterId })).sort({ createdAt: -1 }).limit(100).select({ question: 1, options: 1 }).lean(),
		Campaign.find(scoped(account, { newsletterId, status: { $in: ["sending", "sent"] } }))
			.sort({ sentAt: -1, _id: -1 })
			.limit(RECENT_ISSUES)
			.select({ subject: 1 })
			.lean(),
		Segment.find(scoped(account, { newsletterId, kind: "static", buildStatus: "ready" })).sort({ name: 1 }).select({ name: 1 }).lean(),
	]);
	const links = campaigns.length === 0 ? [] : await CampaignLink.find(scoped(account, { campaignId: { $in: campaigns.map(({ _id }) => _id) } })).sort({ index: 1 }).select({ campaignId: 1, index: 1, url: 1 }).lean();
	return {
		fields: fields.map(({ key, label, type, options, multiple }) => ({ key, label, type, options: options ?? [], multiple: Boolean(multiple) })),
		tags: tags.map(({ name }) => name),
		polls: polls.map(({ _id, question, options }) => ({ id: String(_id), question, options: options.map(({ label }) => label) })),
		issues: campaigns.map(({ _id, subject }) => ({
			id: String(_id),
			subject,
			links: links.filter(({ campaignId }) => String(campaignId) === String(_id)).map(({ index, url }) => ({ index, url })),
		})),
		lists: lists.map(({ _id, name }) => ({ id: String(_id), name })),
	};
}
