import { getAppUrl } from "@/lib/config";
import { siteExtensions } from "@/lib/site-extensions";

// The support chat's full address (siteExtensions.supportChatPath), for emails and the API, which can't open it in
// place. Null without one.
export function getSupportChatUrl() {
	const { supportChatPath } = siteExtensions;
	return supportChatPath ? `${getAppUrl()}${supportChatPath}` : null;
}
