// Subfolder hosting (docs/MOUNT-PATH-DESIGN.md): a newsletter's website at a path of a site its owner runs, such as
// https://example.com/newsletter, whose reverse proxy strips that path and forwards the rest to FlockStack with the mount's
// token in X-FlockStack-Mount. The upstream is the newsletter's shared host (<slug>.<shared domain>) when the server has a
// shared domain, else APP_URL/archive/<slug>; either way the path after the prefix is read as it would be on the newsletter's own
// host. No imports but the public host check: worker-entry.mjs and proxy.js load this before anything else.
import { getPrivateHostProblem } from "./webhook-url.js";

// What the owner's proxy adds. proxy.js answers 403 when it is there and doesn't match.
export const MOUNT_HEADER = "x-flockstack-mount";
// What proxy.js passes on to the app once the token matched, and refuses on a request that arrives with them.
export const MOUNT_PATH_HEADER = "x-flockstack-mount-path";
export const MOUNT_SLUG_HEADER = "x-flockstack-mount-slug";
// "current" or "previous": which token the proxy sent, so a check can say the proxy still has the old one.
export const MOUNT_MATCH_HEADER = "x-flockstack-mount-match";
export const INTERNAL_MOUNT_HEADERS = [MOUNT_PATH_HEADER, MOUNT_SLUG_HEADER, MOUNT_MATCH_HEADER];
// On a mounted answer, for worker-entry.mjs, which rewrites its HTML and takes these off.
export const MOUNTED_RESPONSE_HEADER = "x-flockstack-mounted";
export const MOUNTED_SLUG_RESPONSE_HEADER = "x-flockstack-mounted-slug";
// Where check_newsletter_mount asks, through the owner's site.
export const MOUNT_CHECK_PATH = "/.well-known/flockstack-mount";
export const MAX_MOUNT_URL_LENGTH = 300;
export const MAX_MOUNT_SEGMENTS = 3;

const SEGMENT_PATTERN = /^[A-Za-z0-9._~-]{1,60}$/;
const ARCHIVE_PATH_PATTERN = /^\/archive\/([a-z0-9][a-z0-9-]*)(\/.*)?$/;

// What's wrong with the address of a mount, or null. appHost and sharedDomain: FlockStack's own names, which can't be one.
export function getMountUrlProblem(value, { appHost = null, sharedDomain = null } = {}) {
	const text = String(value ?? "").trim();
	if (!text) return "Enter the address on your site, like https://example.com/newsletter";
	if (text.length > MAX_MOUNT_URL_LENGTH) return `The address can be ${MAX_MOUNT_URL_LENGTH} characters at most`;
	let url;
	try {
		url = new URL(text);
	} catch {
		return "Enter a full address, starting with https://";
	}
	if (url.protocol !== "https:") return "The address has to start with https://";
	if (url.username || url.password) return "Leave the user name and password out of the address";
	if (url.port) return "Use the default https port: leave the port out of the address";
	if (text.includes("?") || text.includes("#")) return "Leave the query and the # part out of the address";
	const segments = url.pathname.replace(/\/+$/, "").split("/").slice(1);
	if (segments.length === 0 || segments[0] === "") return "Add the path your site forwards, like https://example.com/newsletter";
	if (segments.length > MAX_MOUNT_SEGMENTS) return `The path can have ${MAX_MOUNT_SEGMENTS} parts at most, like /newsletter/name`;
	if (segments.some((segment) => !SEGMENT_PATTERN.test(segment) || segment === "." || segment === "..")) {
		return "Use letters, digits, dashes, dots and underscores in the path";
	}
	const host = url.hostname.toLowerCase();
	const own = [appHost, sharedDomain].filter(Boolean).map((name) => String(name).toLowerCase().split(":")[0]);
	if (own.some((name) => host === name || host.endsWith(`.${name}`))) return "That address is FlockStack's own: use your site's address";
	return getPrivateHostProblem(url);
}

// The address as it's stored: https, the host in lowercase, the path without a trailing slash.
export function normalizeMountUrl(value) {
	const url = new URL(String(value).trim());
	return `https://${url.hostname.toLowerCase()}${url.pathname.replace(/\/+$/, "")}`;
}

export function getMountPath(mountUrl) {
	return new URL(mountUrl).pathname;
}

// /archive/<slug>/<rest> on the app's host, or null.
export function splitArchivePath(pathname) {
	const match = ARCHIVE_PATH_PATTERN.exec(pathname);
	return match ? { slug: match[1], rest: match[2] ?? "" } : null;
}

const HOST_PATHS = { "/sitemap": "/sitemap.xml", "/robots": "/robots.txt", "/feed": "/feed.xml", "/llms": "/llms.txt", "/podcast": "/podcast.xml" };

// Where a path under /archive/<slug> lives on the newsletter's own host: the files for crawlers and feed readers have names of
// their own there, and everything else keeps its path.
export function toHostPath(rest) {
	const path = rest || "/";
	const markdown = /^\/markdown\/([a-z0-9-]+)$/.exec(path)?.[1];
	if (markdown) return `/p/${markdown}.md`;
	const audio = /^\/audio\/([a-z0-9-]+)$/.exec(path)?.[1];
	if (audio) return `/audio/${audio}.mp3`;
	return HOST_PATHS[path] ?? path;
}

// The website's HTML pages, as paths on the newsletter's host. A GET for one of these that reaches FlockStack without the mount's
// token is sent to the mount with a 301, so search engines see one address. Nothing else is: not the links in emails, the
// endpoints under /api, /embed.js, the assets, the feeds and files, or the check.
const PAGE_PATTERNS = [
	/^\/$/,
	/^\/(issues|signin|account|perks|sponsor|links|shop|subscribe|give)\/?$/,
	/^\/p\/[a-z0-9][a-z0-9-]{0,119}\/?$/,
	/^\/(tags|authors)\/[a-z0-9][a-z0-9-]{0,59}\/?$/,
	/^\/shop\/[a-z0-9][a-z0-9-]{0,79}\/?$/,
	/^\/offer\/[a-z0-9][a-z0-9-]{1,39}\/?$/,
];

export function isMountPagePath(hostPath) {
	return PAGE_PATTERNS.some((pattern) => pattern.test(hostPath));
}

export function getMountPageUrl(mountUrl, hostPath, search = "") {
	return `${mountUrl}${hostPath === "/" ? "/" : hostPath.replace(/(.)\/$/, "$1")}${search}`;
}

// A root-relative URL in a mounted page, under the mount path: /_next/static/a.js becomes /newsletter/_next/static/a.js, which
// the owner's proxy sends back to FlockStack. A path under /archive/<slug> takes its place on the newsletter's host first.
// Absolute and protocol-relative URLs, fragments and anything else are left alone.
export function toMountedUrl(value, { mountPath, slug }) {
	if (typeof value !== "string" || value[0] !== "/" || value[1] === "/" || value[1] === "\\") return value;
	const cut = value.search(/[?#]/);
	const path = cut === -1 ? value : value.slice(0, cut);
	const tail = cut === -1 ? "" : value.slice(cut);
	const archive = slug ? splitArchivePath(path) : null;
	const inner = archive?.slug === slug ? toHostPath(archive.rest) : path;
	return `${mountPath}${inner}${tail}`;
}

// srcset and imagesrcset: "url 1x, url 2x". next/image's URLs have their commas encoded.
export function toMountedSrcset(value, context) {
	if (typeof value !== "string") return value;
	return value
		.split(/,\s+/)
		.map((candidate) => {
			const [url, ...descriptor] = candidate.trim().split(/\s+/);
			return [toMountedUrl(url, context), ...descriptor].join(" ");
		})
		.join(", ");
}

// A redirect's Location on a mounted answer: on the mount instead of the upstream's own host.
export function toMountedLocation(location, { mountPath, slug, upstreamOrigin }) {
	if (!location) return location;
	if (location[0] === "/") return toMountedUrl(location, { mountPath, slug });
	try {
		const url = new URL(location);
		if (url.origin !== upstreamOrigin) return location;
		return toMountedUrl(`${url.pathname}${url.search}${url.hash}`, { mountPath, slug });
	} catch {
		return location;
	}
}

// Next.js's scripts and the React Server Components data name the build's files as "/_next/static/...": in a mounted page
// those strings get the mount path too, or the browser would ask the owner's site for them.
const NEXT_ASSET_PATTERN = /(["'(])\/_next\//g;

export function toMountedAssetRefs(text, mountPath) {
	return text.replace(NEXT_ASSET_PATTERN, `$1${mountPath}/_next/`);
}

// How long a chunk's end is held back so a string cut between two chunks is still found: `"/_next/` less one.
export const ASSET_REF_TAIL = 7;

// Where Turbopack's runtime loads the chunks it adds later from (TURBOPACK_CHUNK_BASE_PATH, read before it falls back to /_next/).
export function getChunkBaseScript(mountPath) {
	return `<script>self.TURBOPACK_CHUNK_BASE_PATH=${JSON.stringify(`${mountPath}/_next/`)}</script>`;
}

// /archive/<slug>/_next/... in a mounted request on the app's host (APP_URL/archive/<slug> as the upstream): the build's files
// are at /_next/... . null for anything else.
export function getMountedAssetPath(pathname) {
	const archive = splitArchivePath(pathname);
	return archive && archive.rest.startsWith("/_next/") ? archive.rest : null;
}

// What worker-entry.mjs asks for instead, for a request that carries a mount token, before Next.js sees it: the app's own file
// for an asset under /archive/<slug>, and a path without its trailing slash, which Next.js would otherwise redirect to an
// address the owner's site doesn't have. { url, isStatic } or null to leave the request as it is.
export function toMountedRequestUrl(url) {
	const asset = getMountedAssetPath(url.pathname);
	if (asset) return { url: new URL(`${asset}${url.search}`, url), isStatic: asset.startsWith("/_next/static/") };
	if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
		const trimmed = new URL(url);
		trimmed.pathname = url.pathname.replace(/\/+$/, "") || "/";
		return { url: trimmed, isStatic: false };
	}
	return null;
}
