import { getSessionCookie } from "better-auth/cookies";
import { NextResponse } from "next/server";
import { isAppRoute } from "@/lib/app-routes";
import { getArchiveHostUrl } from "@/lib/archive-hosts";
import { isCloud } from "@/lib/config";
import { resolveArchiveHost } from "@/lib/host-routing";
import { findVerifiedMountUrl, matchMount } from "@/lib/mount-routing";
import {
	INTERNAL_MOUNT_HEADERS,
	MOUNTED_RESPONSE_HEADER,
	MOUNTED_SLUG_RESPONSE_HEADER,
	MOUNT_CHECK_PATH,
	MOUNT_HEADER,
	MOUNT_MATCH_HEADER,
	MOUNT_PATH_HEADER,
	MOUNT_SLUG_HEADER,
	getMountPageUrl,
	isMountPagePath,
	splitArchivePath,
} from "@/lib/mount-rules";
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
	// The confirmation page of a briefing note's keep or drop link (lib/briefing-verdict-links.js): the token is the credential.
	/^\/briefing-verdict\/[A-Za-z0-9_.%-]+$/,
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

function rewriteTo(request, pathname, init) {
	const url = request.nextUrl.clone();
	url.pathname = pathname;
	return NextResponse.rewrite(url, init);
}

// A newsletter's host: its pages map onto app/archive/[slug], and the links in its emails stay at their own paths. path is the
// request's path, or for a mounted request (lib/mount-rules.js) the path after the mount's prefix, which reads the same way
// whatever the owner's proxy forwards to. mounted carries the request headers the app reads (lib/mount-request.js).
async function routeArchiveHost(request, slug, path, mounted) {
	const init = mounted?.init;
	const pass = () => (path === request.nextUrl.pathname ? NextResponse.next(init) : rewriteTo(request, path, init));
	if (ARCHIVE_HOST_PATHS.some((pattern) => pattern.test(path))) return pass();
	if (path === "/embed.js") return rewriteTo(request, "/api/embed-script", init);
	if (path === MOUNT_CHECK_PATH) return rewriteTo(request, "/api/mount-check", init);
	if (!slug) return new NextResponse("Not found", { status: 404 });
	if (path === "/") return rewriteTo(request, `/archive/${slug}`, init);
	if (path === "/sitemap.xml") return rewriteTo(request, `/archive/${slug}/sitemap`, init);
	if (path === "/robots.txt") return rewriteTo(request, `/archive/${slug}/robots`, init);
	if (path === "/llms.txt") return rewriteTo(request, `/archive/${slug}/llms`, init);
	if (path === "/feed.xml") return rewriteTo(request, `/archive/${slug}/feed`, init);
	if (path === "/podcast.xml") return rewriteTo(request, `/archive/${slug}/podcast`, init);
	const audioSlug = AUDIO_PATH_PATTERN.exec(path)?.[1];
	if (audioSlug) return rewriteTo(request, `/archive/${slug}/audio/${audioSlug}`, init);
	const markdownSlug = /^\/p\/([a-z0-9-]+)\.md$/.exec(path)?.[1];
	if (markdownSlug) return rewriteTo(request, `/archive/${slug}/markdown/${markdownSlug}`, init);
	if (path === "/shop" || path === "/shop/") return rewriteTo(request, `/archive/${slug}/shop`, init);
	if (path === "/subscribe" || path === "/subscribe/") return rewriteTo(request, `/archive/${slug}/subscribe`, init);
	if (path === "/give" || path === "/give/") return rewriteTo(request, `/archive/${slug}/give`, init);
	const offerCode = OFFER_PATH_PATTERN.exec(path)?.[1];
	if (offerCode) return rewriteTo(request, `/archive/${slug}/offer/${offerCode}`, init);
	if (path === "/links" || path === "/links/") return rewriteTo(request, `/archive/${slug}/links`, init);
	const sitePage = SITE_PAGE_PATHS[path.replace(/(.)\/$/, "$1")];
	if (sitePage) return rewriteTo(request, `/archive/${slug}/${sitePage}`, init);
	const tagSlug = TAG_PATH_PATTERN.exec(path)?.[1];
	if (tagSlug) return rewriteTo(request, `/archive/${slug}/tags/${tagSlug}`, init);
	// The newsletter's redirects (lib/redirect-routing.js): old addresses of imported posts, and the owner's own.
	const redirect = await findRedirect(slug, path);
	if (redirect) {
		const target = withQuery(redirect, request.nextUrl.search);
		return NextResponse.redirect(mounted && target.startsWith("/") ? `${mounted.url}${target}` : new URL(target, request.url), 301);
	}
	const productSlug = PRODUCT_PATH_PATTERN.exec(path)?.[1];
	if (productSlug) return rewriteTo(request, `/archive/${slug}/shop/${productSlug}`, init);
	const issueSlug = ISSUE_PATH_PATTERN.exec(path)?.[1];
	if (issueSlug) return rewriteTo(request, `/archive/${slug}/p/${issueSlug}`, init);
	const authorSlug = AUTHOR_PATH_PATTERN.exec(path)?.[1];
	if (authorSlug) return rewriteTo(request, `/archive/${slug}/authors/${authorSlug}`, init);
	return new NextResponse("Not found", { status: 404 });
}

// A request the owner's proxy sent with the mount's token: the app reads the mount from request headers only this sets, and
// worker-entry.mjs rewrites the answer's URLs under the mount path.
async function routeMounted(request, slug, path, mounted) {
	const headers = new Headers(request.headers);
	headers.delete(MOUNT_HEADER);
	headers.set(MOUNT_PATH_HEADER, mounted.path);
	headers.set(MOUNT_SLUG_HEADER, slug);
	headers.set(MOUNT_MATCH_HEADER, mounted.matched);
	const response = await routeArchiveHost(request, slug, path, { ...mounted, init: { request: { headers } } });
	response.headers.set(MOUNTED_RESPONSE_HEADER, mounted.path);
	response.headers.set(MOUNTED_SLUG_RESPONSE_HEADER, slug);
	return response;
}

function refuseMountToken(path) {
	const headers = { "cache-control": "no-store" };
	if (path === MOUNT_CHECK_PATH) return NextResponse.json({ mounted: false, reason: "wrong_token" }, { status: 403, headers });
	return new NextResponse("The X-FlockStack-Mount token doesn't match this newsletter's subfolder.", { status: 403, headers });
}

export async function proxy(request) {
	const { pathname } = request.nextUrl;
	const mountToken = request.headers.get(MOUNT_HEADER);
	// Only proxy.js says a request is mounted, after the token matched.
	if (INTERNAL_MOUNT_HEADERS.some((name) => request.headers.has(name))) return new NextResponse("Bad request", { status: 400 });

	// The script that frames a signup form (lib/embed-script.js) is /embed.js on every host. Its route is under /api: a folder
	// named embed.js would look like a file to every tool that walks the source.
	if (pathname === "/embed.js") return rewriteTo(request, "/api/embed-script");

	const { isArchiveHost, slug: archiveSlug } = await resolveArchiveHost(request.headers.get("host"));
	// Subfolder hosting: the owner's proxy forwards to the newsletter's host, or to APP_URL/archive/<slug> on a server without a
	// shared domain. Either way what follows the prefix is read as a path on the newsletter's host.
	const archivePath = isArchiveHost ? null : splitArchivePath(pathname);
	const mountSlug = isArchiveHost ? archiveSlug : archivePath?.slug;
	const innerPath = isArchiveHost ? pathname : archivePath?.rest || "/";
	if (mountSlug && mountToken) {
		const mounted = await matchMount(mountSlug, mountToken);
		if (!mounted) return refuseMountToken(innerPath);
		return routeMounted(request, mountSlug, innerPath, mounted);
	}
	if (mountSlug && innerPath === MOUNT_CHECK_PATH) return NextResponse.json({ mounted: false, reason: "missing_token" }, { status: 403, headers: { "cache-control": "no-store" } });
	// A page asked for at the upstream itself, once the subfolder is verified, is sent there: one address for search engines.
	if (mountSlug && (request.method === "GET" || request.method === "HEAD") && isMountPagePath(innerPath)) {
		const mountUrl = await findVerifiedMountUrl(mountSlug);
		// The owner's proxy without its header would send the redirect straight back here.
		if (mountUrl && request.headers.get("x-forwarded-host")?.toLowerCase() === new URL(mountUrl).host) {
			return new NextResponse("The request came through the newsletter's subfolder without the X-FlockStack-Mount header.", { status: 403, headers: { "cache-control": "no-store" } });
		}
		if (mountUrl) return NextResponse.redirect(getMountPageUrl(mountUrl, innerPath, request.nextUrl.search), 301);
	}
	if (isArchiveHost) return routeArchiveHost(request, archiveSlug, pathname, null);

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
