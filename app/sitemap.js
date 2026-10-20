import { getAppUrl, isCloud } from "@/lib/config";
import { DOC_PAGES } from "@/lib/docs/llms";
import { siteExtensions } from "@/lib/site-extensions";
import { isSiteIndexedElsewhere } from "@/lib/site-origin";

// The app domain's pages: the docs, and on FlockStack Cloud the pages its site extensions open. The marketing website
// lists its own in /sitemap-website.xml (app/robots.js). Archive hosts get their own sitemap.xml (proxy.js).
// Read per request, not at build: one build serves every region's Worker, each with its own APP_URL (wrangler.jsonc, env.eu).
export const dynamic = "force-dynamic";

export default function sitemap() {
	const appUrl = getAppUrl();
	// Where another region's address carries the shared pages, this server lists only its own directory.
	const paths = isSiteIndexedElsewhere()
		? ["/recommendations"]
		: [...(isCloud() ? siteExtensions.publicPages : []), "/recommendations", ...DOC_PAGES.map(({ href }) => href)];
	return paths.map((path) => ({ url: path === "/" ? appUrl : `${appUrl}${path}` }));
}
