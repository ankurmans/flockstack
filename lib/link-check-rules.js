import { getPrivateHostProblem } from "./webhook-url.js";

// How the ready-to-send check opens the links of an issue (lib/link-check.js). The request leaves from FlockStack's own
// servers to an address a customer wrote, so it is held to the same rule as a webhook's or a feed's (lib/webhook-url.js,
// lib/feed-url.js): a public name or address, no user name, the default port. Unlike them it may be plain http, since a
// reader's link can be, and a redirect is followed by hand a few times and checked like the first address.
export const LINK_CHECK = { timeoutMs: 6000, redirects: 3, concurrency: 5, maxLinks: 20, cacheMs: 24 * 60 * 60_000, runningMs: 3 * 60_000 };

// What's wrong with an address FlockStack would open, or null.
export function getLinkProblem(value) {
	let url;
	try {
		url = new URL(String(value ?? "").trim());
	} catch {
		return "not an address";
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return "not a web address";
	if (url.username || url.password) return "has a user name in it";
	const isDefaultPort = !url.port || (url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80");
	if (!isDefaultPort) return "uses a port FlockStack doesn't open";
	return getPrivateHostProblem(url) ? "points inside a private network" : null;
}

// Sites that answer a program with these usually answer a person differently: not a broken link.
const GUARDED_STATUSES = new Set([401, 403, 405, 429, 451, 999]);

// ok: a page. unsure: the site refused the check (or took too long), which says nothing about the link. broken: gone.
export function judgeStatus(status) {
	if (status >= 200 && status < 400) return { state: "ok" };
	if (GUARDED_STATUSES.has(status)) return { state: "unsure", reason: `answered ${status}` };
	if (status === 404 || status === 410) return { state: "broken", reason: `${status}, page not found` };
	if (status >= 500) return { state: "unsure", reason: `answered ${status}` };
	return { state: "broken", reason: `answered ${status}` };
}

// A short stable name for a list of addresses, in order-free form.
export function hashLinks(urls) {
	const text = [...urls].sort().join("\n");
	let hash = 5381;
	for (let index = 0; index < text.length; index++) hash = ((hash * 33) ^ text.charCodeAt(index)) >>> 0;
	return `${urls.length}:${hash.toString(36)}`;
}
