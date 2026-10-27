// REFERENCE for the app repository, not website code: the module the app adds as lib/website-routing.js, and what
// worker-entry.mjs does with it (docs/ROUTING.md). It is tested here (tests/routing.test.mjs) so the rule in the checklist is a
// rule that has been run. The website itself never imports it. No imports: the app's worker-entry.mjs loads it before Next.js.

// The paths the website serves, exactly. "/" only for a visitor with no session.
export const WEBSITE_EXACT_PATHS = [
	"/pricing",
	"/compare",
	"/changelog",
	"/tools/newsletter-cost-calculator",
	"/blog",
	"/vs",
	"/alternatives",
	"/switch",
	// The product pages (content/landing in the website repository): each by name, because /docs and /signin are the app's.
	"/newsletter-api",
	"/newsletter-mcp-server",
	"/newsletter-automation",
	"/paid-newsletter-platform",
	"/low-cost-newsletter-platform",
	// The old address of the page above (renamed 2026-10-21): the website answers it with a permanent redirect to the new one.
	"/cheapest-newsletter-platform",
	"/amazon-ses-newsletter",
	"/self-hosted-newsletter",
	// The trust pages: who runs FlockStack, how each charge works, who it is for, and who writes the website's pages.
	"/about",
	"/pricing-explained",
	"/who-its-for",
	"/authors",
	"/llms.txt",
	"/sitemap-website.xml",
];
export const WEBSITE_PREFIXES = ["/blog/", "/vs/", "/alternatives/", "/switch/", "/_website/"];

export function isWebsitePath(pathname) {
	return WEBSITE_EXACT_PATHS.includes(pathname) || WEBSITE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

// Better Auth's session cookie is "<prefix>.session_token", with a "__Secure-" in front on https. The prefix is the region's
// (lib/region.js getCookiePrefix): "better-auth" in the US, "flockstack-eu" in the EU. Only whether it is there, as proxy.js does.
export function hasSessionCookie(cookieHeader, cookiePrefix) {
	const name = `${cookiePrefix}.session_token`;
	return String(cookieHeader ?? "")
		.split(";")
		.some((part) => {
			const key = part.split("=")[0].trim();
			return key === name || key === `__Secure-${name}`;
		});
}

// Whether the app's Worker hands a request to the website through its WEBSITE binding.
//  - Only GET and HEAD: the website has no forms and no API.
//  - Only on the app's own host (APP_URL): a newsletter's own domain has a /pricing or a /blog of its own.
//  - "/" only for a visitor without a session: a signed-in visitor's / is the dashboard.
export function shouldForwardToWebsite({ method, hostname, appHostname, pathname, hasSession }) {
	if (method !== "GET" && method !== "HEAD") return false;
	if (hostname !== appHostname) return false;
	if (pathname === "/") return !hasSession;
	return isWebsitePath(pathname);
}
