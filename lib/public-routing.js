// The pages and files of the app that look the same to every visitor, which FlockStack Cloud's router (workers/router) hands to
// the public pages Worker (workers/public) instead of the app: they are rendered once per deploy by scripts/build-public.mjs
// and served as static files. No imports: the router bundles this module and must stay a few kilobytes.
//
// Exact paths only. A path not listed here (a docs page that does not exist, a trailing slash) goes to the app, which has every
// route and answers as it always did. tests/public-routing.test.mjs keeps this list equal to the docs' page list, the legal
// pages and the routes that write the files.

// app/(site)/docs: lib/docs/pages.js (DOC_PAGES) is the list this repeats.
export const PUBLIC_DOC_PATHS = [
	"/docs",
	"/docs/authentication",
	"/docs/agent-safety",
	"/docs/audiences",
	"/docs/content-calendar",
	"/docs/warnings",
	"/docs/errors",
	"/docs/mcp",
	"/docs/webhooks",
	"/docs/zapier-make",
	"/docs/rss",
	"/docs/briefings",
	"/docs/briefings-bot",
	"/docs/export",
	"/docs/moving",
	"/docs/referrals",
	"/docs/recommendations",
	"/docs/forms",
	"/docs/reports",
	"/docs/comments",
	"/docs/audio",
	"/docs/selling",
	"/docs/regions",
	"/docs/api",
];

// lib/legal.js (LEGAL_PATHS). While a placeholder is left in lib/legal.js the app answers 404 for them, and so does the
// static copy: it is a copy of what the app answered when it was made.
export const PUBLIC_LEGAL_PATHS = ["/terms", "/privacy", "/sub-processors"];

// Routes that write a file: the docs' index for agents, the whole docs for agents, the OpenAPI document, the app's sitemap and
// robots.txt, the web manifest, and the two icons Next.js makes routes of (app/icon.svg, app/apple-icon.png), which every page asks
// for and which would otherwise start the app. /llms.txt is the website's (lib/website-routing.js), which merges /llms-docs.txt into
// it. The icons in public/ (favicon.ico, icon-192.png, icon-512.png) are files of the app's assets, which the platform serves
// without starting the app.
export const PUBLIC_FILE_PATHS = ["/llms-docs.txt", "/llms-full.txt", "/api/v1/openapi.json", "/sitemap.xml", "/robots.txt", "/site.webmanifest", "/icon.svg", "/apple-icon.png"];

export const PUBLIC_EXACT_PATHS = [...PUBLIC_LEGAL_PATHS, ...PUBLIC_DOC_PATHS, ...PUBLIC_FILE_PATHS];

const PUBLIC_PATH_SET = new Set(PUBLIC_EXACT_PATHS);

export function isPublicPath(pathname) {
	return PUBLIC_PATH_SET.has(pathname);
}

// Headers of Next.js's client navigation and server actions: the same address answers them with something other than the page,
// and a static copy of the page is not that. lib/edge-cache.js reads this list too.
export const VARIANT_HEADERS = ["rsc", "next-router-state-tree", "next-router-prefetch", "next-router-segment-prefetch", "next-action", "range", "authorization"];

// Whether a request is a plain visit for the page or file: GET or HEAD, and none of the headers above.
export function isPlainVisit({ method, headers }) {
	if (method !== "GET" && method !== "HEAD") return false;
	return !VARIANT_HEADERS.some((name) => headers.has(name));
}
