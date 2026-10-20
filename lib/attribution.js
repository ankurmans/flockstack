// Where a subscriber came from, kept small on the contact: the channel FlockStack works out, the UTM parameters the page
// was opened with and the host of the page that linked to it. No cookie and no device data: the browser holds the
// values in its local storage for 30 days (lib/storage.js) and hands them over with the signup.

export const UTM_KEYS = ["source", "medium", "campaign", "term", "content"];
export const MAX_ATTRIBUTION_VALUE = 80;
const MAX_INPUT_LENGTH = 700;

export const CHANNELS = ["direct", "search", "social", "email", "paid", "website", "recommendation", "referral", "import", "manual", "api"];
export const CHANNEL_LABELS = {
	direct: "Direct",
	search: "Search",
	social: "Social",
	email: "Email",
	paid: "Paid",
	website: "Other websites",
	recommendation: "Recommendations",
	referral: "Referral program",
	import: "Imports",
	manual: "Added by hand",
	api: "API",
};

const SOCIAL_HOSTS = [
	"facebook.com", "fb.com", "instagram.com", "x.com", "twitter.com", "t.co", "linkedin.com", "lnkd.in", "reddit.com", "youtube.com",
	"youtu.be", "tiktok.com", "pinterest.com", "threads.net", "bsky.app", "mastodon.social", "news.ycombinator.com", "medium.com",
];
const SEARCH_HOSTS = ["bing.com", "duckduckgo.com", "yahoo.com", "baidu.com", "ecosia.org", "brave.com", "kagi.com", "startpage.com", "perplexity.ai", "chatgpt.com"];
const SOCIAL_NAMES = new Set(["facebook", "fb", "instagram", "ig", "twitter", "x", "linkedin", "reddit", "youtube", "tiktok", "pinterest", "threads", "bluesky", "mastodon", "hackernews", "hn"]);
const SEARCH_NAMES = new Set(["google", "bing", "duckduckgo", "yahoo", "baidu", "ecosia", "brave", "kagi"]);
const EMAIL_MEDIA = new Set(["email", "e-mail", "newsletter", "mail"]);
const PAID_MEDIA = new Set(["cpc", "ppc", "paid", "paidsocial", "paid-social", "paid_social", "display", "cpm", "ads", "ad", "sponsored", "affiliate"]);
// Signups made on the newsletter's own pages, and the shop's.
const OWN_SOURCES = new Set(["website", "popup", "gate", "shop", "paid"]);
const GOOGLE_HOST = /^(?:[a-z0-9-]+\.)*google\.[a-z.]{2,6}$/;
const YANDEX_HOST = /^(?:[a-z0-9-]+\.)*yandex\.[a-z.]{2,6}$/;

// Control characters out, spaces collapsed, lowercase: "Newsletter-Swap " and "newsletter-swap" are one campaign in a report.
export function cleanValue(value) {
	const text = String(value ?? "")
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase()
		.slice(0, MAX_ATTRIBUTION_VALUE);
	return text || undefined;
}

// read(name) gives the value of a parameter, utm_source and the like, or nothing. { source, medium, … } for the ones
// present, or null.
export function readUtm(read) {
	const utm = {};
	for (const key of UTM_KEYS) {
		const value = cleanValue(read(`utm_${key}`));
		if (value) utm[key] = value;
	}
	return Object.keys(utm).length > 0 ? utm : null;
}

function matchesHost(host, list) {
	return list.some((name) => host === name || host.endsWith(`.${name}`));
}

// The host of an address or of a bare host, without www; null for anything that isn't a web page, and for the newsletter's
// own hosts (ownHosts), which are no referrer.
export function toReferrerHost(value, ownHosts = []) {
	const text = String(value ?? "").trim().slice(0, 600);
	if (!text) return null;
	let host;
	try {
		const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
		if (url.protocol !== "https:" && url.protocol !== "http:") return null;
		host = url.hostname.toLowerCase().replace(/^www\./, "");
	} catch {
		return null;
	}
	if (!host.includes(".") || host.length > MAX_ATTRIBUTION_VALUE) return null;
	return ownHosts.some((own) => own && (host === own || host === String(own).replace(/^www\./, ""))) ? null : host;
}

// The sources FlockStack itself writes. Anything else (website, popup, a form, a magic link, a custom word from the API)
// is judged on what the visitor brought.
export function getStructuralChannel(source) {
	const text = String(source ?? "");
	if (text === "import") return "import";
	if (text === "dashboard") return "manual";
	if (text.startsWith("recommendation")) return "recommendation";
	if (text === "referral") return "referral";
	return null;
}

export function classifyChannel({ source, utm, referrer } = {}) {
	const structural = getStructuralChannel(source);
	if (structural) return structural;
	const medium = utm?.medium;
	if (medium && PAID_MEDIA.has(medium)) return "paid";
	if (medium && EMAIL_MEDIA.has(medium)) return "email";
	if (medium === "social" || medium === "social-media") return "social";
	if (medium === "organic" || medium === "search") return "search";
	const name = utm?.source;
	if (name && SOCIAL_NAMES.has(name)) return "social";
	if (name && SEARCH_NAMES.has(name)) return "search";
	if (name && /newsletter|email/.test(name)) return "email";
	if (referrer) {
		if (GOOGLE_HOST.test(referrer) || YANDEX_HOST.test(referrer) || matchesHost(referrer, SEARCH_HOSTS)) return "search";
		if (matchesHost(referrer, SOCIAL_HOSTS)) return "social";
		return "website";
	}
	if (name || medium) return "website";
	// A magic link lives in another newsletter's email; an API signup came from a form on another site.
	if (source === "magic-link") return "email";
	if (source && !OWN_SOURCES.has(String(source)) && !String(source).startsWith("form:")) return "api";
	return "direct";
}

// What goes on the contact: { channel, utm: { source, medium, campaign, term, content }, referrer } with the parts present.
export function buildAcquisition({ source, utm, referrer, ownHosts } = {}) {
	const host = toReferrerHost(referrer, ownHosts);
	const cleaned = {};
	for (const key of UTM_KEYS) if (utm?.[key]) cleaned[key] = cleanValue(utm[key]);
	const channel = classifyChannel({ source, utm: cleaned, referrer: host });
	return { channel, ...(Object.keys(cleaned).length > 0 && { utm: cleaned }), ...(host && { referrer: host }) };
}

// The hidden field a signup form sends: JSON of { u: utm, r: referrer host }. Anything else is ignored.
export function parseAttributionInput(raw) {
	const text = String(raw ?? "");
	if (!text || text.length > MAX_INPUT_LENGTH) return {};
	try {
		const parsed = JSON.parse(text);
		const utm = parsed && typeof parsed.u === "object" && parsed.u ? readUtm((name) => parsed.u[name.slice(4)]) : null;
		return { utm, referrer: typeof parsed?.r === "string" ? parsed.r : undefined };
	} catch {
		return {};
	}
}

export function serializeAttributionInput({ utm, referrer }) {
	if (!utm && !referrer) return "";
	return JSON.stringify({ ...(utm && { u: utm }), ...(referrer && { r: referrer }) });
}

// The UTM parameters of a request's address and its Referer, for the endpoints a form posts to.
export function readRequestAttribution({ searchParams, formData, referer, ownHosts }) {
	const read = (name) => formData?.get(name) || searchParams?.get(name);
	return { utm: readUtm(read), referrer: toReferrerHost(referer, ownHosts) ?? undefined };
}
