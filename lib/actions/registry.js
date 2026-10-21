import "server-only";
import { exportActions } from "@/lib/actions/account-export";
import { aiActions } from "@/lib/actions/ai";
import { agentSafetyActions } from "@/lib/actions/agent-safety";
import { apiKeyActions } from "@/lib/actions/api-keys";
import { audioActions } from "@/lib/actions/audio";
import { automationActions } from "@/lib/actions/automations";
import { billingActions } from "@/lib/actions/billing";
import { calendarActions } from "@/lib/actions/calendar";
import { campaignActions } from "@/lib/actions/campaigns";
import { campaignBulkActions } from "@/lib/actions/campaign-bulk";
import { campaignVersionActions } from "@/lib/actions/campaign-versions";
import { commentActions } from "@/lib/actions/comments";
import { connectedAppActions } from "@/lib/actions/connected-apps";
import { compActions } from "@/lib/actions/comps";
import { contactActions } from "@/lib/actions/contacts";
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
import { postImportActions } from "@/lib/actions/post-imports";
import { productActions } from "@/lib/actions/products";
import { segmentActions } from "@/lib/actions/segments";
import { stockPhotoActions } from "@/lib/actions/stock-photos";
import { seriesActions } from "@/lib/actions/series";
import { surveyActions } from "@/lib/actions/surveys";
import { templateActions } from "@/lib/actions/templates";
import { tagActions } from "@/lib/actions/tags";
import { uploadActions } from "@/lib/actions/uploads";
import { webhookActions } from "@/lib/actions/webhooks";
import { websiteActions } from "@/lib/actions/website";

// Every customer action, in the order the docs list them. Admin and sign-in aren't customer actions.
const ALL_ACTIONS = [
	...overviewActions,
	...reportActions,
	...newsletterActions,
	...websiteActions,
	...linkPageActions,
	...campaignActions,
	...campaignBulkActions,
	...campaignVersionActions,
	...calendarActions,
	...feedActions,
	...seriesActions,
	...templateActions,
	...contactActions,
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
	...giftActions,
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
