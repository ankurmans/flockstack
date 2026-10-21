// Which Worker takes a request, apart from the router's entry (workers/router/index.js): a Worker module can export nothing but
// its handler, and the tests want these. Three small imports, no Next.js.
import { getCookiePrefix } from "../../lib/region.js";
import { isPlainVisit, isPublicPath } from "../../lib/public-routing.js";
import { hasSessionCookie, shouldForwardToWebsite } from "../../lib/website-routing.js";

// How long WEBSITE and PUBLIC get to start answering (headers) before the app does; ROUTER_TIMEOUT_MS overrides it.
export const DEFAULT_TIMEOUT_MS = 3000;
export const HEALTH_PATH = "/__router/health";
export const FALLBACK_STATUSES = [502, 503, 504];
// The website's scripts, fonts, social cards and manifest (lib/website-routing.js, "/_website/"). The app has no copy of them, so
// when the website is slow to start they are asked for again, for longer, and never handed to the app: its answer would be a 404
// that a crawler keeps as the share image's answer. ROUTER_ASSET_RETRY_MS overrides the second wait.
// A workers.dev address is a staging door, not a page of the site: whatever answers on it is told not to be indexed, so a search
// engine that finds it never holds a second copy of flockstack.io. The header is only for those hostnames.
export const isWorkersDevHost = (hostname) => hostname === "workers.dev" || hostname.endsWith(".workers.dev");

export const ASSET_PREFIX = "/_website/";
export const DEFAULT_ASSET_RETRY_MS = 10000;

// Where a request for the domain itself must go first, or null: plain http goes to https, and www.<domain> goes to <domain>, with the
// path and the query kept, as a permanent redirect that keeps the method (308). Only the router's own hosts: a workers.dev address,
// which is https only, and any other host are left alone. Pure, so the whole table is tested without a Worker.
export function chooseRedirect({ url, env }) {
	if (!env.APP_URL) return null;
	const appHostname = new URL(env.APP_URL).hostname;
	const isApp = url.hostname === appHostname;
	const isWww = url.hostname === `www.${appHostname}`;
	if (!isApp && !isWww) return null;
	if (url.protocol !== "http:" && !isWww) return null;
	const target = new URL(url);
	target.protocol = "https:";
	target.hostname = appHostname;
	target.port = "";
	return target.toString();
}

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
	// The domain is the app's own host. So is a workers.dev address, which only a router that is being tried out has (the
	// routers that hold a domain have workers_dev off): the routing can be tested there before the domain moves.
	if (url.hostname !== appHostname && !url.hostname.endsWith(".workers.dev")) return "app";
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
