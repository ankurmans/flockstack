import { getAppUrl } from "@/lib/config";

// The dashboard and the newsletter setup, the admin, the APIs, apps' consent and tracked links. / stays open: on
// FlockStack Cloud, signed-out visitors get the landing page there. Sign-in stays open too, so crawlers that follow
// the public pages' links to it read its noindex. Archive hosts get their own robots.txt (proxy.js).
const PRIVATE_PATHS = [
	"/account",
	"/admin",
	"/api/",
	"/api-keys",
	"/audio",
	"/automations",
	"/billing",
	"/campaigns",
	"/comments",
	"/contacts",
	"/domains",
	"/forms",
	"/link-page",
	"/media",
	"/mcp",
	"/newsletters",
	"/orders",
	"/payments",
	"/products",
	"/oauth/",
	"/recommending",
	"/reader/",
	"/referrals",
	"/reports",
	"/restore",
	"/segments",
	"/series",
	"/surveys",
	"/templates",
	"/poll",
	"/survey",
	"/preferences",
	"/webhooks",
	"/website",
	"/welcome",
	"/c/",
	"/o/",
];

// Read per request, not at build: one build serves every region's Worker, each with its own APP_URL (wrangler.jsonc, env.eu).
export const dynamic = "force-dynamic";

export default function robots() {
	return {
		rules: { userAgent: "*", allow: "/", disallow: PRIVATE_PATHS },
		sitemap: `${getAppUrl()}/sitemap.xml`,
	};
}
