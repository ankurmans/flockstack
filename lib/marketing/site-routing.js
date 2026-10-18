import { LEGAL_PATHS, getPublishedLegalPages } from "@/lib/legal";

// FlockStack Cloud's routing for proxy.js (see lib/site-routing.js): kept apart from the site extensions so the middleware
// doesn't bundle the support assistant. Its landing page renders at "/home" for signed-out visitors at "/".
export const LANDING_PATH = "/home";

export const siteRouting = {
	landingPath: LANDING_PATH,
	// The legal pages (app/(site)/terms and the others) are about FlockStack Cloud, so a self-hosted server answers 404 for them.
	// Read when asked: they are listed only once lib/legal.js has no placeholder left.
	get publicPages() {
		return ["/", ...getPublishedLegalPages().map(({ href }) => href)];
	},
	// The support assistant answers signed-out visitors too, on the home page, docs, legal pages and sign-in. The legal
	// pages open while hidden too, so a visitor gets their 404 rather than the sign-in page.
	isPublicPath: (pathname) => /^\/home\/opengraph-image(-\w+)?$/.test(pathname) || pathname === "/api/support/chat" || LEGAL_PATHS.includes(pathname),
};
