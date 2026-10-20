// A newsletter's redirects, as proxy.js matches them and the actions store them: the path of a request on its website
// (custom domain or <slug>.<shared domain>), without the query, decoded, lowercased and without a trailing slash, so
// /P/Old-Post/ and /p/old-post match one rule.
export const MAX_REDIRECT_PATH = 300;
export const MAX_REDIRECT_TARGET = 2000;
// A website's rules, automatic and by hand together: far above what an import of the largest plan adds.
export const MAX_REDIRECTS_PER_NEWSLETTER = 25_000;
export const MAX_REDIRECT_CSV_ROWS = 1000;

// Paths the website answers itself, which proxy.js serves before it looks at redirects: a rule there would never run.
const RESERVED_PATHS = [
	/^\/$/,
	/^\/(sitemap\.xml|robots\.txt|llms\.txt|feed\.xml|favicon\.ico|shop|subscribe|unsubscribe|confirm|keep|referral)$/,
	/^\/(api|reader|o|c|_next|archive)(\/|$)/,
];

export function normalizeRedirectPath(value) {
	let path = String(value ?? "").trim();
	if (/^https?:\/\//i.test(path)) {
		try {
			path = new URL(path).pathname;
		} catch {
			return null;
		}
	}
	path = path.split(/[?#]/)[0];
	if (!path.startsWith("/")) path = `/${path}`;
	try {
		path = decodeURI(path);
	} catch {
		return null;
	}
	path = path.toLowerCase().replace(/\/{2,}/g, "/");
	if (path.length > 1) path = path.replace(/\/+$/, "");
	if (path.length > MAX_REDIRECT_PATH || /[\s<>"\\]/.test(path)) return null;
	return path;
}

export function isReservedRedirectPath(path) {
	return RESERVED_PATHS.some((pattern) => pattern.test(path));
}

// Where a rule sends people: a path on the same website, or an https:// address anywhere.
export function normalizeRedirectTarget(value) {
	const text = String(value ?? "").trim();
	if (!text || text.length > MAX_REDIRECT_TARGET || /[\s<>"\\]/.test(text)) return null;
	if (text.startsWith("/") && !text.startsWith("//")) return text;
	try {
		const url = new URL(text);
		return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
	} catch {
		return null;
	}
}

// A redirect target with the request's query string kept, unless the target has its own: links shared with
// ?utm_source=… keep it.
export function withQuery(target, search) {
	if (!search || target.includes("?")) return target;
	const hash = target.indexOf("#");
	return hash === -1 ? `${target}${search}` : `${target.slice(0, hash)}${search}${target.slice(hash)}`;
}
