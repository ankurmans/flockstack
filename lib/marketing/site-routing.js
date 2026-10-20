import { CUSTOM_PATH } from "@/lib/custom-choices";
import { LEGAL_PATHS, getPublishedLegalPages } from "@/lib/legal";

// FlockStack Cloud's routing for proxy.js (see lib/site-routing.js): kept apart from the site extensions so the middleware
// doesn't bundle the support assistant. The marketing website is a separate Worker (worker-entry.mjs hands it its paths),
// so nothing here is a landing page: a signed-out visitor at "/" is sent to sign in when the website isn't there.
export const siteRouting = {
	// The Custom plan page and the legal pages (app/(site)/terms and the others) are about FlockStack Cloud, so a self-hosted
	// server answers 404 for them. Read when asked: the legal pages are listed only once lib/legal.js has no placeholder left.
	get publicPages() {
		return [CUSTOM_PATH, ...getPublishedLegalPages().map(({ href }) => href)];
	},
	// The support assistant answers signed-out visitors too, on the docs, legal pages and sign-in. The legal
	// pages open while hidden too, so a visitor gets their 404 rather than the sign-in page.
	isPublicPath: (pathname) => pathname === "/api/support/chat" || LEGAL_PATHS.includes(pathname),
};
