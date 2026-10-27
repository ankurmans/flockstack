import { getSessionCookie } from "better-auth/cookies";
import { NextResponse } from "next/server";
import { isAppRoute } from "@/lib/app-routes";
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
	/^\/reader\/billing$/,
	/^\/reader\/sponsorships\/(verify|manage)$/,
	/^\/sponsor-assets\/[a-f0-9]{24}\/[A-Za-z0-9_-]{43}$/,
	/^\/api\/sponsorship-assets$/,
	/^\/api\/health$/,
	/^\/favicon\.ico$/,
	/^\/(robots\.txt|sitemap\.xml|site\.webmanifest)$/,
	/^\/opengraph-image(-\w+)?$/,
	/^\/signin$/,
	/^\/oauth\/consent$/,
	/^\/\.well-known\/(oauth-protected-resource(\/mcp)?|oauth-authorization-server|openid-configuration)$/,
	/^\/docs(\/.*)?$/,
	/^\/llms(-full|-docs)?\.txt$/,
	/^\/mcp$/,
	/^\/api\/mcp$/,
	/^\/api\/auth\//,
	/^\/unsubscribe$/,
	/^\/confirm$/,
	/^\/keep$/,
	/^\/referral$/,
	/^\/signup-flow$/,
	/^\/reader\/(in|signin|replies)$/,
	/^\/reader\/groups\/(buy|complete|invite|manage)$/,
	/^\/(poll|poll\/results|survey|preferences)$/,
	/^\/(pledge|gift|gifts)$/,
	/^\/o\//,
	/^\/c\//,
	/^\/p\//,
	/^\/archive\//,
	/^\/api\/unsubscribe$/,
	/^\/api\/views$/,
	/^\/api\/recommendations\/impression$/,
	/^\/api\/visit$/,
	/^\/api\/reader-(translation|subscriptions)$/,
	/^\/api\/reader-perks\/[^/]+\/[^/]+$/,
	/^\/embed\/[a-f0-9]{24}$/i,
	/^\/f\/[a-f0-9]{24}$/i,
	/^\/subscribe\/magic$/,
	/^\/recommendations$/,
	/^\/api\/shop\/(download|portal)$/,
	/^\/api\/v1\//,
	// The API Worker asks the app to drop a cached page (lib/internal-revalidate.js): the signature is the credential.
	/^\/api\/internal\/revalidate$/,
	/^\/api\/inbound-replies$/,
	/^\/api\/agent-workspaces(\/[^/]+)?$/,
	/^\/api\/webhooks\//,
	/^\/api\/jobs\//,
	/^\/api\/cron\//,
];

// A newsletter's host carries its archive and the links in its emails, never the dashboard, not even its login page.
const ARCHIVE_HOST_PATHS = [
	/^\/reader\/billing$/,
	/^\/unsubscribe$/,
	/^\/api\/unsubscribe$/,
	/^\/api\/views$/,
	/^\/api\/recommendations\/impression$/,
	// A page view of the website (lib/web-analytics.js).
	/^\/api\/visit$/,
	/^\/api\/reader-(translation|subscriptions)$/,
	/^\/api\/reader-perks\/[^/]+\/[^/]+$/,
	// Signup forms for other sites (lib/forms.js): the frame's page and the address a form posts to, and Magic Links
	// (lib/magic-links.js).
	/^\/embed\/[a-f0-9]{24}$/i,
	/^\/f\/[a-f0-9]{24}$/i,
	/^\/subscribe\/magic$/,
	/^\/api\/shop\/(download|portal)$/,
	/^\/confirm$/,
	/^\/keep$/,
	/^\/referral$/,
	/^\/signup-flow$/,
	/^\/reader\/(in|signin|replies)$/,
	// Polls, surveys and the preference center (lib/subscriber-links.js).
	/^\/(poll|poll\/results|survey|preferences)$/,
	// A pledger's cancel link, and the gift links (lib/paid-links.js).
	/^\/(pledge|gift|gifts)$/,
	/^\/o\//,
	/^\/c\//,
];
const AUDIO_PATH_PATTERN = /^\/audio\/([a-z0-9][a-z0-9-]{0,119})\.mp3$/;
const ISSUE_PATH_PATTERN = /^\/p\/([a-z0-9][a-z0-9-]{0,119})\/?$/;
const PRODUCT_PATH_PATTERN = /^\/shop\/([a-z0-9][a-z0-9-]{0,78}[a-z0-9]|[a-z0-9])\/?$/;
const OFFER_PATH_PATTERN = /^\/offer\/([a-z0-9][a-z0-9-]{1,38}[a-z0-9])\/?$/;
const AUTHOR_PATH_PATTERN = /^\/authors\/([a-z0-9][a-z0-9-]{0,59})\/?$/;
const TAG_PATH_PATTERN = /^\/tags\/([a-z0-9][a-z0-9-]{0,59})\/?$/;
// The list of issues, the reader's sign-in and the Subscriber Center are pages of the newsletter's site, not routes of their own.
const SITE_PAGE_PATHS = { "/issues": "issues", "/signin": "signin", "/account": "account", "/perks": "perks", "/sponsor": "sponsor" };
// Generated share images stay on the app domain, where social cards point: they're only PNGs.
const ARCHIVE_IMAGE_PATH_PATTERN = /^\/archive\/[^/]+\/og$/;

function rewriteTo(request, pathname) {
	const url = request.nextUrl.clone();
	url.pathname = pathname;
	return NextResponse.rewrite(url);
}

export async function proxy(request) {
	const { pathname } = request.nextUrl;

	// The script that frames a signup form (lib/embed-script.js) is /embed.js on every host. Its route is under /api: a folder
	// named embed.js would look like a file to every tool that walks the source.
	if (pathname === "/embed.js") return rewriteTo(request, "/api/embed-script");

	const { isArchiveHost, slug: archiveSlug } = await resolveArchiveHost(request.headers.get("host"));
	if (isArchiveHost) {
		if (ARCHIVE_HOST_PATHS.some((pattern) => pattern.test(pathname))) return NextResponse.next();
		if (!archiveSlug) return new NextResponse("Not found", { status: 404 });
		if (pathname === "/") return rewriteTo(request, `/archive/${archiveSlug}`);
		if (pathname === "/sitemap.xml") return rewriteTo(request, `/archive/${archiveSlug}/sitemap`);
		if (pathname === "/robots.txt") return rewriteTo(request, `/archive/${archiveSlug}/robots`);
		if (pathname === "/llms.txt") return rewriteTo(request, `/archive/${archiveSlug}/llms`);
		if (pathname === "/feed.xml") return rewriteTo(request, `/archive/${archiveSlug}/feed`);
		if (pathname === "/podcast.xml") return rewriteTo(request, `/archive/${archiveSlug}/podcast`);
		const audioSlug = AUDIO_PATH_PATTERN.exec(pathname)?.[1];
		if (audioSlug) return rewriteTo(request, `/archive/${archiveSlug}/audio/${audioSlug}`);
		const markdownSlug = /^\/p\/([a-z0-9-]+)\.md$/.exec(pathname)?.[1];
		if (markdownSlug) return rewriteTo(request, `/archive/${archiveSlug}/markdown/${markdownSlug}`);
		if (pathname === "/shop" || pathname === "/shop/") return rewriteTo(request, `/archive/${archiveSlug}/shop`);
		if (pathname === "/subscribe" || pathname === "/subscribe/") return rewriteTo(request, `/archive/${archiveSlug}/subscribe`);
		if (pathname === "/give" || pathname === "/give/") return rewriteTo(request, `/archive/${archiveSlug}/give`);
		const offerCode = OFFER_PATH_PATTERN.exec(pathname)?.[1];
		if (offerCode) return rewriteTo(request, `/archive/${archiveSlug}/offer/${offerCode}`);
		if (pathname === "/links" || pathname === "/links/") return rewriteTo(request, `/archive/${archiveSlug}/links`);
		const sitePage = SITE_PAGE_PATHS[pathname.replace(/(.)\/$/, "$1")];
		if (sitePage) return rewriteTo(request, `/archive/${archiveSlug}/${sitePage}`);
		const tagSlug = TAG_PATH_PATTERN.exec(pathname)?.[1];
		if (tagSlug) return rewriteTo(request, `/archive/${archiveSlug}/tags/${tagSlug}`);
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

	// The old landing page was rendered from / at /home, and may still be linked or indexed there. / is the marketing
	// website's home page for a visitor (worker-entry.mjs) and the dashboard for a signed-in person.
	if (pathname === "/home") return NextResponse.redirect(new URL("/", request.url), 308);

	// Only whether a session cookie is there: pages, actions and routes check the session itself.
	const hasSession = Boolean(getSessionCookie(request, { cookiePrefix: getCookiePrefix() }));
	// FlockStack Cloud's pages that open without a session (site extensions). A self-hosted server has none of them.
	// The marketing website is a separate Worker the app hands its paths to before this runs (worker-entry.mjs).
	const { publicPages, isPublicPath } = siteRouting;
	if (isCloud()) {
		if (publicPages.includes(pathname) || isPublicPath(pathname)) return NextResponse.next();
	} else if (pathname !== "/" && publicPages.includes(pathname)) {
		return rewriteTo(request, NOT_FOUND_PATH);
	}
	if (PUBLIC_PATHS.some((pattern) => pattern.test(pathname))) return NextResponse.next();
	if (hasSession) return NextResponse.next();
	if (pathname === "/") return NextResponse.redirect(new URL("/signin", request.url));

	if (pathname.startsWith("/api/")) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
	// Anything that isn't a dashboard page is a public page or none: Next.js renders it, or its 404. A signed-out visitor
	// is sent to sign in only from a page that needs a session.
	if (!isAppRoute(pathname)) return NextResponse.next();
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
