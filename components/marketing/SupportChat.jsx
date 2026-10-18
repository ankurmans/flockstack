import PanelSupportChat from "@/components/marketing/PanelSupportChat";
import { isCloud } from "@/lib/config";
import { getAiBinding, getSupportAddress } from "@/lib/marketing/support-config";
import { siteExtensions } from "@/lib/site-extensions";

// FlockStack Cloud's help chat, as SupportChat in components/SiteExtensions.jsx: a "Help" button and the assistant's
// panel, on FlockStack's own pages only (the same layouts as SiteAnalytics, tests/analytics-routes.test.mjs). Nothing
// renders without the Worker's Workers AI binding, so a server without it shows no button that can't answer.
export default async function SupportChat({ user = null }) {
	if (!isCloud() || !(await getAiBinding())) return null;
	return <PanelSupportChat isSignedIn={Boolean(user)} supportEmail={getSupportAddress()} openPath={siteExtensions.supportChatPath} />;
}
