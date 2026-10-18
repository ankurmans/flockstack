import { getAppUrl, isCloud } from "@/lib/config";
import { DOC_PAGES } from "@/lib/docs/llms";
import { siteExtensions } from "@/lib/site-extensions";

// The app domain's pages: the docs, and on FlockStack Cloud its marketing site's. Archive hosts get their own
// sitemap.xml (proxy.js).
// Read per request, not at build: one build serves every region's Worker, each with its own APP_URL (wrangler.jsonc, env.eu).
export const dynamic = "force-dynamic";

export default function sitemap() {
	const appUrl = getAppUrl();
	return [...(isCloud() ? siteExtensions.publicPages : []), ...DOC_PAGES.map(({ href }) => href)].map((path) => ({
		url: path === "/" ? appUrl : `${appUrl}${path}`,
	}));
}
