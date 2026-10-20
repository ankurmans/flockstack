import "server-only";
import { exportActions } from "@/lib/actions/account-export";
import { aiActions } from "@/lib/actions/ai";
import { apiKeyActions } from "@/lib/actions/api-keys";
import { automationActions } from "@/lib/actions/automations";
import { billingActions } from "@/lib/actions/billing";
import { campaignActions } from "@/lib/actions/campaigns";
import { campaignVersionActions } from "@/lib/actions/campaign-versions";
import { commentActions } from "@/lib/actions/comments";
import { connectedAppActions } from "@/lib/actions/connected-apps";
import { contactActions } from "@/lib/actions/contacts";
import { domainActions } from "@/lib/actions/domains";
import { mediaActions } from "@/lib/actions/media";
import { newsletterActions } from "@/lib/actions/newsletters";
import { overviewActions } from "@/lib/actions/overview";
import { recommendationActions } from "@/lib/actions/recommendations";
import { redirectActions } from "@/lib/actions/redirects";
import { referralActions } from "@/lib/actions/referrals";
import { paymentActions } from "@/lib/actions/payments";
import { pollActions } from "@/lib/actions/polls";
import { postImportActions } from "@/lib/actions/post-imports";
import { productActions } from "@/lib/actions/products";
import { segmentActions } from "@/lib/actions/segments";
import { stockPhotoActions } from "@/lib/actions/stock-photos";
import { surveyActions } from "@/lib/actions/surveys";
import { tagActions } from "@/lib/actions/tags";
import { uploadActions } from "@/lib/actions/uploads";
import { webhookActions } from "@/lib/actions/webhooks";

// Every customer action, in the order the docs list them. Admin and sign-in aren't customer actions.
export const ACTIONS = [
	...overviewActions,
	...newsletterActions,
	...campaignActions,
	...campaignVersionActions,
	...contactActions,
	...postImportActions,
	...redirectActions,
	...referralActions,
	...recommendationActions,
	...commentActions,
	...tagActions,
	...segmentActions,
	...pollActions,
	...surveyActions,
	...automationActions,
	...domainActions,
	...paymentActions,
	...productActions,
	...uploadActions,
	...mediaActions,
	...stockPhotoActions,
	...aiActions,
	...apiKeyActions,
	...connectedAppActions,
	...webhookActions,
	...billingActions,
	...exportActions,
];

const BY_NAME = new Map(ACTIONS.map((action) => [action.name, action]));
if (BY_NAME.size !== ACTIONS.length) throw new Error("Two actions share a name");

export function getAction(name) {
	return BY_NAME.get(name) ?? null;
}

export const ACTION_GROUPS = [...new Set(ACTIONS.map(({ group }) => group))];
