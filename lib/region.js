// FlockStack Cloud runs this same code as one Worker per region, each with its own database and buckets: flockstack.io
// (FLOCKSTACK_REGION=us) and eu.flockstack.io (eu). An account lives in exactly one of them, and nothing here looks across.
// Everything reads process.env when called: a Worker has no env at module load.
export const REGIONS = ["us", "eu"];
export const REGION_NAMES = { us: "United States", eu: "European Union" };
// "Your data is stored in …"
export const REGION_PLACES = { us: "the United States", eu: "the European Union" };

const DEFAULT_URLS = { us: "https://flockstack.io", eu: "https://eu.flockstack.io" };

// Better Auth's own prefix stays on the US Worker, so the sessions that exist today keep working.
const COOKIE_PREFIXES = { us: "better-auth", eu: "flockstack-eu" };

// The 27 EU members, Iceland, Liechtenstein and Norway (the EEA), the UK and Switzerland: where the picker starts on the EU.
const EU_COUNTRIES = new Set(
	"AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO GB CH".split(" ")
);

// A visitor's choice, kept for a year in a cookie of this host. Only a preference, never read as proof of anything.
export const REGION_COOKIE = "region";
export const REGION_COOKIE_MAX_AGE = 365 * 24 * 3600;

export function isRegion(value) {
	return REGIONS.includes(value);
}

// The region this Worker serves. Unset or anything unknown is "us": self-hosted servers and FlockStack Cloud's first
// deployment don't set it.
export function getRegion(env = process.env) {
	return String(env.FLOCKSTACK_REGION ?? "").trim().toLowerCase() === "eu" ? "eu" : "us";
}

export function isEu(env = process.env) {
	return getRegion(env) === "eu";
}

export function getOtherRegion(region) {
	return region === "eu" ? "us" : "eu";
}

export function getCookiePrefix(env = process.env) {
	return COOKIE_PREFIXES[getRegion(env)];
}

// Each region's app address, from REGION_URL_US and REGION_URL_EU.
export function getRegionUrls(env = process.env) {
	const read = (name, region) => String(env[name] ?? "").trim().replace(/\/+$/, "") || DEFAULT_URLS[region];
	return { us: read("REGION_URL_US", "us"), eu: read("REGION_URL_EU", "eu") };
}

// The sign-in address in a region: a path on this Worker's own host for its own region, the other Worker's address
// otherwise. region= tells the other one the choice was made, so it doesn't offer it again.
export function getSigninUrl(region, { next = "/", env = process.env } = {}) {
	const query = new URLSearchParams({ region });
	if (next && next !== "/") query.set("next", next);
	const path = `/signin?${query}`;
	return region === getRegion(env) ? path : `${getRegionUrls(env)[region]}${path}`;
}

export function getRegionForCountry(country) {
	const code = String(country ?? "").trim().toUpperCase();
	return code ? (EU_COUNTRIES.has(code) ? "eu" : "us") : null;
}

// Cloudflare adds the visitor's country to every request it proxies; the Worker's request.cf carries the same value.
export function readCountry(headers, cf) {
	return headers.get("cf-ipcountry") || cf?.country || null;
}

// What the picker starts on, and why: ?region= and the region cookie are the visitor's own choice and win; then their
// country; with neither, the region of the Worker they are on. The country only counts on the US Worker, the front door
// at flockstack.io: whoever opened eu.flockstack.io went there on purpose, wherever they are.
export function chooseRegion({ query, cookie, country, env = process.env }) {
	if (isRegion(query)) return { region: query, source: "query" };
	if (isRegion(cookie)) return { region: cookie, source: "cookie" };
	const byCountry = isEu(env) ? null : getRegionForCountry(country);
	if (byCountry) return { region: byCountry, source: "country" };
	return { region: getRegion(env), source: "deployment" };
}

// What the picker lists: each region, its host and where choosing it leads.
export function getRegionOptions({ next = "/", env = process.env } = {}) {
	const urls = getRegionUrls(env);
	return REGIONS.map((id) => ({ id, name: REGION_NAMES[id], host: new URL(urls[id]).host, href: getSigninUrl(id, { next, env }) }));
}

// Webhooks from a provider that delivers to both Workers include events for accounts that live in the other region.
// Those are acknowledged with a 2xx and an info line, never an alert or a retry.
export function noteOtherRegion(label, what) {
	console.info(`[${label}] ${what}: no such account in this region (${getRegion()}), acknowledged`);
}
