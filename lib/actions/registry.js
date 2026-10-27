import { collaborationActions } from "@/lib/actions/collaboration";
import { readerRetentionActions } from "@/lib/actions/reader-retention";
import { sponsorshipActions } from "@/lib/actions/sponsorships";
import { groupSubscriptionActions } from "@/lib/actions/group-subscriptions";
import { replyRuleActions } from "@/lib/actions/reply-rules";
import { accountAssistantActions } from "@/lib/actions/account-assistant";
import { subscriptionRevenueActions } from "@/lib/actions/subscription-revenue";
import { shortPostActions } from "@/lib/actions/short-posts";
import { creatorMatchActions } from "@/lib/actions/creator-matches";
import { issueLinkActions } from "@/lib/actions/issue-links";
import { mailingListActions } from "@/lib/actions/mailing-lists";
import "server-only";
import { perkActions } from "@/lib/actions/perks";
import { campaignPreviewActions } from "@/lib/actions/campaign-previews";
import { authorActions } from "@/lib/actions/authors";
import { readerActions } from "@/lib/actions/readers";
import { subscriberImportActions } from "@/lib/actions/subscriber-import";
import { teamActions } from "@/lib/actions/team";
import { agentActions } from "@/lib/actions/agents";
import { fleetActions } from "@/lib/actions/fleet";
import { exportActions } from "@/lib/actions/account-export";
import { aiActions } from "@/lib/actions/ai";
import { agentSafetyActions } from "@/lib/actions/agent-safety";
import { apiKeyActions } from "@/lib/actions/api-keys";
import { audioActions } from "@/lib/actions/audio";
import { automationActions } from "@/lib/actions/automations";
import { billingActions } from "@/lib/actions/billing";
import { calendarActions } from "@/lib/actions/calendar";
import { campaignActions } from "@/lib/actions/campaigns";
import { campaignCheckActions } from "@/lib/actions/campaign-checks";
import { campaignBulkActions } from "@/lib/actions/campaign-bulk";
import { campaignVersionActions } from "@/lib/actions/campaign-versions";
import { commentActions } from "@/lib/actions/comments";
import { connectedAppActions } from "@/lib/actions/connected-apps";
import { compActions } from "@/lib/actions/comps";
import { contactActions } from "@/lib/actions/contacts";
import { contentBatchActions } from "@/lib/actions/content-batches";
import { contentItemActions } from "@/lib/actions/content-items";
import { domainActions } from "@/lib/actions/domains";
import { formActions } from "@/lib/actions/forms";
import { linkPageActions } from "@/lib/actions/link-page";
import { mediaActions } from "@/lib/actions/media";
import { feedActions } from "@/lib/actions/feeds";
import { newsletterActions } from "@/lib/actions/newsletters";
import { overviewActions } from "@/lib/actions/overview";
import { recommendationActions } from "@/lib/actions/recommendations";
import { redirectActions } from "@/lib/actions/redirects";
import { referralActions } from "@/lib/actions/referrals";
import { giftActions } from "@/lib/actions/gifts";
import { offerActions } from "@/lib/actions/offers";
import { paidTierActions } from "@/lib/actions/paid-tiers";
import { reportActions } from "@/lib/actions/reports";
import { paymentActions } from "@/lib/actions/payments";
import { pledgeActions } from "@/lib/actions/pledges";
import { pollActions } from "@/lib/actions/polls";
import { publishedIssueActions } from "@/lib/actions/published-issues";
import { postImportActions } from "@/lib/actions/post-imports";
import { productActions } from "@/lib/actions/products";
import { segmentActions } from "@/lib/actions/segments";
import { stockPhotoActions } from "@/lib/actions/stock-photos";
import { seriesActions } from "@/lib/actions/series";
import { surveyActions } from "@/lib/actions/surveys";
import { templateActions } from "@/lib/actions/templates";
import { tagActions } from "@/lib/actions/tags";
import { uploadActions } from "@/lib/actions/uploads";
import { giftLinkActions } from "@/lib/actions/gift-links";
import { signupApprovalActions } from "@/lib/actions/signup-approval";
import { webhookActions } from "@/lib/actions/webhooks";
import { websiteActions } from "@/lib/actions/website";

// Every customer action, in the order the docs list them. Admin and sign-in aren't customer actions.
const ALL_ACTIONS = [
	...replyRuleActions,
	...accountAssistantActions,
	...subscriptionRevenueActions,
	...shortPostActions,
	...creatorMatchActions,
	...issueLinkActions,
	...mailingListActions,
	...perkActions,
	...campaignPreviewActions,
	...authorActions,
	...readerActions,
	...subscriberImportActions,
	...teamActions,
	...agentActions,
	...fleetActions,
	...overviewActions,
	...reportActions,
	...newsletterActions,
	...websiteActions,
	...linkPageActions,
	...campaignActions,
	...campaignBulkActions,
	...campaignCheckActions,
	...campaignVersionActions,
	...publishedIssueActions,
	...calendarActions,
	...contentItemActions,
	...contentBatchActions,
	...feedActions,
	...seriesActions,
	...templateActions,
	...contactActions,
	...signupApprovalActions,
	...formActions,
	...postImportActions,
	...redirectActions,
	...referralActions,
	...recommendationActions,
	...commentActions,
	...audioActions,
	...tagActions,
	...segmentActions,
	...pollActions,
	...surveyActions,
	...automationActions,
	...domainActions,
	...paymentActions,
	...paidTierActions,
	...pledgeActions,
	...offerActions,
	...groupSubscriptionActions,
	...collaborationActions,
	...readerRetentionActions,
	...sponsorshipActions,
	...giftActions,
	...giftLinkActions,
	...compActions,
	...productActions,
	...uploadActions,
	...mediaActions,
	...stockPhotoActions,
	...aiActions,
	...apiKeyActions,
	...connectedAppActions,
	...agentSafetyActions,
	...webhookActions,
	...billingActions,
	...exportActions,
];

// What the REST API, MCP, the OpenAPI document and the docs have. The dashboard-only ones (deciding an approval, turning on
// "ask me before an agent sends") run through the same runAction but have no route, no tool and no page: no key can reach them.
export const ACTIONS = ALL_ACTIONS.filter(({ dashboardOnly }) => !dashboardOnly);
export const DASHBOARD_ONLY_ACTIONS = ALL_ACTIONS.filter(({ dashboardOnly }) => dashboardOnly);

const BY_NAME = new Map(ALL_ACTIONS.map((action) => [action.name, action]));
if (BY_NAME.size !== ALL_ACTIONS.length) throw new Error("Two actions share a name");

export function getAction(name) {
	return BY_NAME.get(name) ?? null;
}

export const ACTION_GROUPS = [...new Set(ACTIONS.map(({ group }) => group))];
