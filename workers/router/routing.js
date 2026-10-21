// Which Worker takes a request, apart from the router's entry (workers/router/index.js): a Worker module can export nothing but
// its handler, and the tests want these. Three small imports, no Next.js.
import { getApiGroup, parseEnabledGroups } from "../../lib/api-routing.js";
import { getCookiePrefix } from "../../lib/region.js";
import { isPlainVisit, isPublicPath } from "../../lib/public-routing.js";
import { hasSessionCookie, shouldForwardToWebsite } from "../../lib/website-routing.js";

// How long WEBSITE and PUBLIC get to start answering (headers) before the app does; ROUTER_TIMEOUT_MS overrides it.
export const DEFAULT_TIMEOUT_MS = 3000;
export const HEALTH_PATH = "/__router/health";
export const FALLBACK_STATUSES = [502, 503, 504];
// How long the API Worker gets to start answering a GET, HEAD or OPTIONS before the app does as well: an API call can be slower
// than a page, and asking the app costs a second run of it. ROUTER_API_TIMEOUT_MS overrides it. A request that changes something
// is never timed out and asked again (see askApi in index.js).
export const DEFAULT_API_TIMEOUT_MS = 10_000;
// The API Worker's own words for "I did nothing, ask the app" (it is switched off or has no database), sent before it reads a body.
export const API_UNPROCESSED_HEADER = "x-fs-api-unprocessed";
export const API_MISS_HEADER = "x-fs-api-miss";
// A request with a body this big or smaller is copied before the API Worker gets it, so the app can be asked in its place if the
// API Worker says it did nothing. A bigger one is not copied: the API Worker's answer is the answer.
export const MAX_REPLAY_BYTES = 1024 * 1024;
export const SAFE_METHODS = ["GET", "HEAD", "OPTIONS"];

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

// Which Worker takes a request: "website", "public", "api" or "app", or what the router answers itself: "skip-prefetch" and
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
	// The domain is the app's own host. So is a workers.dev address, which only a router that is being tried out has (the
	// routers that hold a domain have workers_dev off): the routing can be tested there before the domain moves.
	if (url.hostname !== appHostname && !url.hostname.endsWith(".workers.dev")) return "app";
	// The API: REST, MCP and the OAuth endpoints an MCP client calls, every method (lib/api-routing.js). Off unless the router has the
	// API binding and API_ENABLED names the request's group, so it can be switched off in seconds without a deploy.
	// A workers.dev address (a router being tried; the same Worker as the domain's) has a switch of its own, API_ENABLED_WORKERS_DEV, so
	// the API Worker can be tried there while the domain still goes to the app.
	const apiGroup = env.API ? getApiGroup(url.pathname) : null;
	const isTrial = url.hostname !== appHostname;
	if (apiGroup && parseEnabledGroups(isTrial ? env.API_ENABLED_WORKERS_DEV : env.API_ENABLED).has(apiGroup) && !(env.PUBLIC && isPublicPath(url.pathname) && isPlainVisit({ method, headers }))) return "api";
	if (method !== "GET" && method !== "HEAD") return "app";
	const hasSession = hasSessionCookie(headers.get("cookie"), getCookiePrefix(env));
	const toWebsite = Boolean(env.WEBSITE) && shouldForwardToWebsite({ method, hostname: appHostname, appHostname, pathname: url.pathname, hasSession });
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
