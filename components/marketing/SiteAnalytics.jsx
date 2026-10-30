import ProviderAnalytics from "@/components/marketing/ProviderAnalytics";
import { isCloud } from "@/lib/config";
import { isLegalPublished } from "@/lib/legal";
import { getAccountPlan } from "@/lib/plans";
import { readAnalyticsEnv } from "@/lib/marketing/analytics-config";
import { toSignupSource } from "@/lib/marketing/analytics-privacy";
import { readAnalyticsRequest } from "@/lib/marketing/analytics-request";
import { getRegion } from "@/lib/region";

// FlockStack Cloud's product analytics (PostHog), as SiteAnalytics in components/SiteExtensions.jsx. It goes in the
// layouts of FlockStack's own pages only: the docs, legal pages, sign-in and the signed-in dashboard. Never in the root
// layout, and never on a newsletter's pages, the pages readers use, or the admin (tests/analytics-routes.test.mjs lists
// where it is). The marketing website, a separate Worker, loads its own copy on its home, product, pricing, comparison, migration
// and blog pages. user and account identify a signed-in person; signupSource is the ?cta= of the sign-in address (the website's sign-up button), kept only if toSignupSource knows it.
// No POSTHOG_KEY renders nothing, without waiting for the request.
export default function SiteAnalytics({ user = null, account = null, signupSource = null }) {
	if (!isCloud() || !readAnalyticsEnv()) return null;
	return <AnalyticsForRequest user={user} account={account} signupSource={signupSource} />;
}

async function AnalyticsForRequest({ user, account, signupSource }) {
	const request = await readAnalyticsRequest();
	if (!request) return null;
	const { token, host, replay, requiresConsent, consent } = request;
	const source = toSignupSource(signupSource);
	const identity = user && account ? { id: String(user.id), email: user.email, plan: getAccountPlan(account).id } : null;
	return <ProviderAnalytics token={token} host={host} replay={replay} region={getRegion()} requiresConsent={requiresConsent} consent={consent} identity={identity} {...(source && { signupSource: source })} privacyHref={isLegalPublished() ? "/privacy" : null} />;
}
