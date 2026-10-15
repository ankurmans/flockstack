import { getAppUrl, isCloud } from "@/lib/config";
import { DOC_PAGES } from "@/lib/docs/llms";
import { siteExtensions } from "@/lib/site-extensions";

// The app domain's pages: the docs, and on MailCheap Cloud its marketing site's. Archive hosts get their own
// sitemap.xml (proxy.js).
export default function sitemap() {
	const appUrl = getAppUrl();
	return [...(isCloud() ? siteExtensions.publicPages : []), ...DOC_PAGES.map(({ href }) => href)].map((path) => ({
		url: path === "/" ? appUrl : `${appUrl}${path}`,
	}));
}
