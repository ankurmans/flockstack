// The requests FlockStack Cloud's router (workers/router) hands to the lean readers Worker (workers/readers) instead of the app: what
// a reader's mail client or browser sends by itself, in bursts when a campaign goes out, and that needs no page rendered: the open
// pixel, the click redirect, unsubscribe, the beacons the archive pages send and the address signup forms post to. Pages that
// render React (the archive, the preference center, polls, the confirm page whose button is a server action) stay with the app.
// No imports: the router bundles this module and must stay a few kilobytes, and the readers Worker uses it to decide what is its
// own. tests/reader-routing.test.mjs keeps these lists equal to the routes the app has.
//
// Unlike the API, these paths arrive on every host: the app's own and each newsletter's (`<slug>.<SHARED_DOMAIN>` or its own
// domain), because the links in a newsletter's emails live on its host. The routes decide nothing by host (proxy.js lets them through
// for all of them), so neither does this.

// The groups an operator can switch on one at a time (READERS_ENABLED in workers/router).
export const READER_GROUPS = ["tracking", "unsubscribe", "beacons", "forms"];

// Each group's paths, as patterns tested on the path without a trailing slash. A path a pattern matches goes to the Worker with
// whatever method it has: an unknown method gets the answer Next.js gives (405 and Allow).
export const READER_PATHS = {
	// /o/<token>: the 1x1 pixel; /c/<token>: the redirect (GET and HEAD).
	tracking: [/^\/o\/[^/]+$/, /^\/c\/[^/]+$/],
	// /api/unsubscribe: GET sends the browser to the page, POST is RFC 8058's one-click and the page's form.
	unsubscribe: [/^\/api\/unsubscribe$/],
	// A page view, a website visit and the recommendations shown: 204 beacons.
	beacons: [/^\/api\/views$/, /^\/api\/visit$/, /^\/api\/recommendations\/impression$/],
	// /f/<24 hex> is where a signup form posts (lib/forms.js); /embed.js is the script that frames a form on another site.
	forms: [/^\/f\/[a-f0-9]{24}$/i, /^\/embed\.js$/],
};

// Which group a path belongs to, or null. A trailing slash is the same address for Next.js (it redirects), so it is the same here.
export function getReaderGroup(pathname) {
	const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
	for (const group of READER_GROUPS) if (READER_PATHS[group].some((pattern) => pattern.test(path))) return group;
	return null;
}

export function isReaderPath(pathname) {
	return getReaderGroup(pathname) !== null;
}

// "all" or "true" (every group), "" or "false" (none), or a list such as "tracking,beacons". Unknown names are ignored, so a typo
// switches less on, never more.
export function parseReaderGroups(value) {
	const text = String(value ?? "").trim().toLowerCase();
	if (!text || text === "false" || text === "off" || text === "0") return new Set();
	if (text === "true" || text === "all" || text === "on" || text === "1") return new Set(READER_GROUPS);
	return new Set(text.split(/[\s,]+/).filter((name) => READER_GROUPS.includes(name)));
}
