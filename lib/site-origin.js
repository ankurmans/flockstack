import { getAppUrl, isCloud } from "@/lib/config";
import { siteExtensions } from "@/lib/site-extensions";

// The address the shared pages (app/(site)) are indexed at: this server's own, unless FlockStack Cloud's marketing site
// names another region's (lib/marketing/site-extensions.js). Read per request: one build serves every region's Worker.
export function getSiteOrigin() {
	return (isCloud() && siteExtensions.getCanonicalOrigin()) || getAppUrl();
}

// Whether this server's copy of the shared pages is indexed at another address.
export function isSiteIndexedElsewhere() {
	return getSiteOrigin() !== getAppUrl();
}
