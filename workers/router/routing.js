// Which Worker takes a request, apart from the router's entry (workers/router/index.js): a Worker module can export nothing but
// its handler, and the tests want these. Three small imports, no Next.js.
import { getCookiePrefix } from "../../lib/region.js";
import { isPlainVisit, isPublicPath } from "../../lib/public-routing.js";
import { hasSessionCookie, shouldForwardToWebsite } from "../../lib/website-routing.js";

// How long WEBSITE and PUBLIC get to start answering (headers) before the app does; ROUTER_TIMEOUT_MS overrides it.
export const DEFAULT_TIMEOUT_MS = 3000;
export const HEALTH_PATH = "/__router/health";
export const FALLBACK_STATUSES = [502, 503, 504];

const PREFETCH_HEADERS = ["next-router-prefetch", "next-router-segment-prefetch"];

// The path of the page a Next.js request was made from (its next-url header), or null.
function readOriginPath(headers) {
	const value = headers.get("next-url");
	if (!value) return null;
	try {
		return new URL(value, "https://origin.invalid").pathname;
	} catch {
		return null;
	}
}

// Which Worker takes a request: "website", "public" or "app", or what the router answers itself: "skip-prefetch" and
// "hard-navigation". Pure, so the whole table is tested without a Worker.
//
// Next.js's links ask for a page's data (an RSC request) before and when it is clicked. The data of a page the website or PUBLIC
// serves is not one the app has to produce, and asking the app for it would start the whole app for every visit to a docs
// page (a docs page prefetches twenty links). So: a prefetch from one of those pages, or for one, is answered with nothing
// (204: Next.js drops it), and a click on a link to one is answered with a page that is not RSC data, which makes Next.js load
// the address as a plain page (a hard navigation), served from PUBLIC or the website as a visit.
export function chooseRoute({ method, url, headers, env }) {
	if (!env.APP_URL) return "app";
	const appHostname = new URL(env.APP_URL).hostname;
	if (url.hostname !== appHostname) return "app";
	if (method !== "GET" && method !== "HEAD") return "app";
	const hasSession = hasSessionCookie(headers.get("cookie"), getCookiePrefix(env));
	const toWebsite = Boolean(env.WEBSITE) && shouldForwardToWebsite({ method, hostname: url.hostname, appHostname, pathname: url.pathname, hasSession });
	const toPublic = Boolean(env.PUBLIC) && isPublicPath(url.pathname);

	if (headers.has("rsc") && !headers.has("next-action") && (env.PUBLIC || env.WEBSITE)) {
		const isPrefetch = PREFETCH_HEADERS.some((name) => headers.has(name));
		const fromPublic = Boolean(env.PUBLIC) && isPublicPath(readOriginPath(headers));
		if (isPrefetch && (toWebsite || toPublic || fromPublic)) return "skip-prefetch";
		if (!isPrefetch && (toWebsite || toPublic)) return "hard-navigation";
		return "app";
	}
	if (toWebsite) return "website";
	if (toPublic && isPlainVisit({ method, headers })) return "public";
	return "app";
}
