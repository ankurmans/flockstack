// The dashboard's pages: the top-level folders of app/(app), app/(account) and app/admin, the newsletter setup and the
// page a deleted account waits on. Without a session, proxy.js sends these to sign-in, and robots.txt keeps crawlers out;
// any other path is a public page or answers 404. Each page checks the session itself (its layout or the page), so this
// list decides where a signed-out visitor lands, not who gets in. A new top-level folder goes here
// (tests/app-routes.test.mjs).
export const APP_ROUTES = [
	"/account",
	"/admin",
	"/agent-activity",
	"/api-keys",
	"/approvals",
	"/assistant",
	"/audio",
	"/authors",
	"/automations",
	"/billing",
	"/campaigns",
	"/claim-workspace",
	"/comments",
	"/contacts",
	"/domains",
	"/fleet",
	"/forms",
	"/group-subscriptions",
	"/sponsorships",
	"/link-page",
	"/media",
	"/newsletters",
	"/orders",
	"/payments",
	"/perks",
	"/gift-links",
	"/mailing-lists",
	"/products",
	"/recommending",
	"/referrals",
	"/reader-settings",
	"/reader-billing",
	"/replies",
	"/reports",
	"/restore",
	"/segments",
	"/series",
	"/surveys",
	"/templates",
	"/team",
	"/webhooks",
	"/website",
	"/welcome",
];

// A whole segment only: /campaigns and /campaigns/123, never /campaigns-guide.
export function isAppRoute(pathname) {
	return APP_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}
