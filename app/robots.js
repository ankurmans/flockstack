import { APP_ROUTES } from "@/lib/app-routes";
import { getAppUrl, isCloud } from "@/lib/config";
import { isSiteIndexedElsewhere } from "@/lib/site-origin";

// The dashboard and the newsletter setup, the admin, the APIs, apps' consent and tracked links. / stays open: on
// FlockStack Cloud it's the marketing website's home page (worker-entry.mjs). Sign-in stays open too, so crawlers that
// follow the public pages' links to it read its noindex. Archive hosts get their own robots.txt (proxy.js).
// The dashboard's folders come from lib/app-routes.js; the rest are public routes that crawlers have no use for.
const PRIVATE_PATHS = [...APP_ROUTES, "/api/", "/mcp", "/oauth/", "/reader/", "/poll", "/survey", "/preferences", "/c/", "/o/"];

// The API's OpenAPI document is public, linked from the docs and llms.txt. The longer rule wins over Disallow: /api/
// for Google, Bing and every crawler that follows RFC 9309, and no other API path opens.
const PUBLIC_API_PATHS = ["/api/v1/openapi.json"];

// Read per request, not at build: one build serves every region's Worker, each with its own APP_URL (wrangler.jsonc, env.eu).
export const dynamic = "force-dynamic";

export default function robots() {
	return {
		rules: { userAgent: "*", allow: ["/", ...PUBLIC_API_PATHS], disallow: PRIVATE_PATHS },
		// FlockStack Cloud's marketing website lists its own pages in a sitemap of its own (docs/ROUTING.md of the website),
		// on the address the shared pages are indexed at: not on the EU Worker's.
		sitemap: isCloud() && !isSiteIndexedElsewhere() ? [`${getAppUrl()}/sitemap.xml`, `${getAppUrl()}/sitemap-website.xml`] : `${getAppUrl()}/sitemap.xml`,
	};
}
