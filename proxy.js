import { getSessionCookie } from "better-auth/cookies";
import { NextResponse } from "next/server";
import { getArchiveHostUrl } from "@/lib/archive-hosts";
import { isCloud } from "@/lib/config";
import { resolveArchiveHost } from "@/lib/host-routing";
import { withQuery } from "@/lib/redirect-paths";
import { findRedirect } from "@/lib/redirect-routing";
import { getCookiePrefix } from "@/lib/region";
import { siteRouting } from "@/lib/site-routing";

// No route can live under an underscore folder, so this always renders the not-found page with a 404.
const NOT_FOUND_PATH = "/_not-on-this-server";

// Reachable without a session: recipients, mail providers, AWS, Stripe, QStash, Vercel Cron, API-key
// and OAuth clients (REST and MCP, OAuth discovery), the docs and uptime checks. The consent page checks
// the session itself, so a signed-out visitor goes to sign-in with the app's request.
const PUBLIC_PATHS = [
	/^\/api\/health$/,
	/^\/favicon\.ico$/,
	/^\/(robots\.txt|sitemap\.xml|site\.webmanifest)$/,
	/^\/opengraph-image(-\w+)?$/,
	/^\/signin$/,
	/^\/oauth\/consent$/,
	/^\/\.well-known\/(oauth-protected-resource(\/mcp)?|oauth-authorization-server|openid-configuration)$/,
	/^\/docs(\/.*)?$/,
	/^\/llms(-full)?\.txt$/,
	/^\/mcp$/,
	/^\/api\/mcp$/,
	/^\/api\/auth\//,
	/^\/unsubscribe$/,
	/^\/confirm$/,
	/^\/keep$/,
	/^\/referral$/,
	/^\/reader\/(in|signin|replies)$/,
	/^\/(poll|poll\/results|survey|preferences)$/,
	/^\/o\//,
	/^\/c\//,
	/^\/p\//,
	/^\/archive\//,
	/^\/api\/unsubscribe$/,
	/^\/api\/views$/,
	/^\/api\/recommendations\/impression$/,
	/^\/recommendations$/,
	/^\/api\/shop\/(download|portal)$/,
	/^\/api\/v1\//,
	/^\/api\/webhooks\//,
	/^\/api\/jobs\//,
	/^\/api\/cron\//,
];

// A newsletter's host carries its archive and the links in its emails, never the dashboard, not even its login page.
const ARCHIVE_HOST_PATHS = [
	/^\/unsubscribe$/,
	/^\/api\/unsubscribe$/,
	/^\/api\/views$/,
	/^\/api\/recommendations\/impression$/,
	/^\/api\/shop\/(download|portal)$/,
	/^\/confirm$/,
	/^\/keep$/,
	/^\/referral$/,
	/^\/reader\/(in|signin|replies)$/,
	// Polls, surveys and the preference center (lib/subscriber-links.js).
	/^\/(poll|poll\/results|survey|preferences)$/,
	/^\/o\//,
	/^\/c\//,
];
const ISSUE_PATH_PATTERN = /^\/p\/([a-z0-9][a-z0-9-]{0,119})\/?$/;
const PRODUCT_PATH_PATTERN = /^\/shop\/([a-z0-9][a-z0-9-]{0,78}[a-z0-9]|[a-z0-9])\/?$/;
const AUTHOR_PATH_PATTERN = /^\/authors\/([a-z0-9][a-z0-9-]{0,59})\/?$/;
// Generated share images stay on the app domain, where social cards point: they're only PNGs.
const ARCHIVE_IMAGE_PATH_PATTERN = /^\/archive\/[^/]+\/og$/;

function rewriteTo(request, pathname) {
	const url = request.nextUrl.clone();
	url.pathname = pathname;
	return NextResponse.rewrite(url);
}

export async function proxy(request) {
	const { pathname } = request.nextUrl;

	const { isArchiveHost, slug: archiveSlug } = await resolveArchiveHost(request.headers.get("host"));
	if (isArchiveHost) {
		if (ARCHIVE_HOST_PATHS.some((pattern) => pattern.test(pathname))) return NextResponse.next();
		if (!archiveSlug) return new NextResponse("Not found", { status: 404 });
		if (pathname === "/") return rewriteTo(request, `/archive/${archiveSlug}`);
		if (pathname === "/sitemap.xml") return rewriteTo(request, `/archive/${archiveSlug}/sitemap`);
		if (pathname === "/robots.txt") return rewriteTo(request, `/archive/${archiveSlug}/robots`);
		if (pathname === "/llms.txt") return rewriteTo(request, `/archive/${archiveSlug}/llms`);
		if (pathname === "/feed.xml") return rewriteTo(request, `/archive/${archiveSlug}/feed`);
		if (pathname === "/shop" || pathname === "/shop/") return rewriteTo(request, `/archive/${archiveSlug}/shop`);
		if (pathname === "/subscribe" || pathname === "/subscribe/") return rewriteTo(request, `/archive/${archiveSlug}/subscribe`);
		// The newsletter's redirects (lib/redirect-routing.js): old addresses of imported posts, and the owner's own.
		const redirect = await findRedirect(archiveSlug, pathname);
		if (redirect) return NextResponse.redirect(new URL(withQuery(redirect, request.nextUrl.search), request.url), 301);
		const productSlug = PRODUCT_PATH_PATTERN.exec(pathname)?.[1];
		if (productSlug) return rewriteTo(request, `/archive/${archiveSlug}/shop/${productSlug}`);
		const issueSlug = ISSUE_PATH_PATTERN.exec(pathname)?.[1];
		if (issueSlug) return rewriteTo(request, `/archive/${archiveSlug}/p/${issueSlug}`);
		const authorSlug = AUTHOR_PATH_PATTERN.exec(pathname)?.[1];
		if (authorSlug) return rewriteTo(request, `/archive/${archiveSlug}/authors/${authorSlug}`);
		return new NextResponse("Not found", { status: 404 });
	}

	// Issues carry HTML from the API and the editor. They're read on the newsletter's host, so that HTML never
	// shares the dashboard's origin. Without SHARED_DOMAIN (local dev) every archive stays under /archive, where
	// the sanitizer, the frame's sandbox and the CSP guard it.
	if (pathname.startsWith("/archive/") && process.env.NODE_ENV === "production" && !ARCHIVE_IMAGE_PATH_PATTERN.test(pathname)) {
		const archiveUrl = getArchiveHostUrl(pathname, request.nextUrl.search);
		if (archiveUrl) return NextResponse.redirect(archiveUrl, 308);
	}

	// Only whether a session cookie is there: pages, actions and routes check the session itself.
	const hasSession = Boolean(getSessionCookie(request, { cookiePrefix: getCookiePrefix() }));
	// FlockStack Cloud's marketing site (site extensions): its landing page shows at / to signed-out visitors, rendered
	// at landingPath, which never shows in the address bar. A self-hosted server has none of its pages.
	const { landingPath, publicPages, isPublicPath } = siteRouting;
	if (isCloud()) {
		if (pathname === "/" && landingPath) return hasSession ? NextResponse.next() : rewriteTo(request, landingPath);
		if (pathname === landingPath) return NextResponse.redirect(new URL("/", request.url), 308);
		if (publicPages.includes(pathname) || isPublicPath(pathname)) return NextResponse.next();
	} else if (pathname === landingPath || (pathname !== "/" && publicPages.includes(pathname))) {
		return rewriteTo(request, NOT_FOUND_PATH);
	}
	if (PUBLIC_PATHS.some((pattern) => pattern.test(pathname))) return NextResponse.next();
	if (hasSession) return NextResponse.next();
	if (pathname === "/") return NextResponse.redirect(new URL("/signin", request.url));

	if (pathname.startsWith("/api/")) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
	const signin = new URL("/signin", request.url);
	signin.searchParams.set("next", `${pathname}${request.nextUrl.search}`);
	return NextResponse.redirect(signin);
}

// favicon.ico goes through the proxy so archive domains answer 404 and browsers keep the newsletter's logo. An export
// uploaded for a post import doesn't: the proxy buffers a request's body, only its first 10 MB, and the route checks the
// session itself.
export const config = {
	matcher: ["/((?!_next/static|_next/image|api/post-imports$|.*\\.(?:png|svg|jpg|webp)$).*)"],
};
