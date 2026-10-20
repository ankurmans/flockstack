// What FlockStack's own analytics (PostHog) may send. Nothing here reads a newsletter, a subscriber or a contact: a
// signed-in person is an ID with an email address and a plan, an event is one of the few below with the few properties
// listed, and everything PostHog collects by itself (page views, clicks) is scrubbed of text and query strings before it
// leaves the browser (sanitizeEvent). tests/analytics-privacy.test.mjs checks the names.

// The explicit events, each with the properties it may carry and the values they may take. track() drops the rest.
export const EVENTS = Object.freeze({
	signup_completed: {},
	newsletter_created: {},
	campaign_sent: { when: ["now", "scheduled"] },
	plan_started: {},
	// The help chat (components/marketing/PanelSupportChat.jsx): counts only, never what was asked or answered.
	support_opened: {},
	support_answered: {},
});

// On a signed-in person, with their user ID as the distinct ID. Nothing else about them.
export const PERSON_PROPERTIES = Object.freeze(["email", "plan"]);

// On every event: which deployment the visitor was on.
export const SUPER_PROPERTIES = Object.freeze(["region"]);

// The steps the server reports for the browser's next page (siteExtensions.sendGoalOnNextPage), as events.
export const GOAL_EVENTS = Object.freeze({
	signup_completed: "signup_completed",
	onboarding_completed: "newsletter_created",
	newsletter_created: "newsletter_created",
	plan_started: "plan_started",
	campaign_sent: "campaign_sent",
	support_opened: "support_opened",
	support_answered: "support_answered",
});

export const GOAL_COOKIE = "fs_goal";
export const GOAL_COOKIE_MAX_AGE = 10 * 60;

// Property names that would carry what readers and creators wrote: none of them is allowed in EVENTS, SUPER_PROPERTIES or
// a person's properties (email is the one person property, named in PERSON_PROPERTIES).
export const FORBIDDEN_PROPERTY_PATTERN =
	/subject|body|content|html|text|title|draft|message|comment|contact|subscriber|recipient|reader|audience|segment|newsletter|name|address|phone|token|secret|password|key/i;

// The event and the properties to send for a goal, or null for one that isn't counted.
export function toEvent(goal, props = {}) {
	const name = Object.hasOwn(GOAL_EVENTS, goal) ? GOAL_EVENTS[goal] : null;
	if (!name) return null;
	const allowed = EVENTS[name];
	const clean = {};
	for (const [key, values] of Object.entries(allowed)) {
		if (Object.hasOwn(props ?? {}, key) && values.includes(props[key])) clean[key] = props[key];
	}
	return { name, props: clean };
}

// What the browser may tell PostHog about a person.
export function toPersonProperties({ email, plan }) {
	return { email: String(email ?? ""), plan: String(plan ?? "none") };
}

const BUILT_IN_EVENTS = new Set(["$pageview", "$pageleave", "$autocapture", "$identify", "$set", "$rageclick", "$opt_in"]);
// FlockStack's own pages, where the text of what was clicked is the page's own words. Everywhere else (the dashboard) a
// link or button can hold a subscriber's email address or an issue's subject, so no text leaves.
const PUBLIC_PATH = /^\/(home|docs|privacy|terms|sub-processors|signin)(\/|$)/;
const URL_KEY = /url|referrer|href/i;
// Autocapture's attributes that can hold what someone typed or what a contact is called.
const PRIVATE_ATTRIBUTES = /^attr__(aria-label|title|value|alt|placeholder)$/;

// Where analytics never runs: a newsletter's pages, what emails link to, the reader and comment pages, the directory
// readers use, the shop and subscribe pages, the admin and the API. The layouts decide where it loads; this is the
// second lock, for a page change inside the browser that leaves for one of them (tests/analytics-routes.test.mjs
// keeps it in step with the layouts).
// The changelog and the Custom plan form have no analytics: the privacy policy (ANALYTICS_RULE in lib/legal.js) names the pages that do.
const UNTRACKED_PATH = /^\/(admin|archive|reader|recommendations|unsubscribe|confirm|keep|poll|survey|preferences|referral|pledge|gift|gifts|give|offer|restore|oauth|api|mcp|p|o|c|shop|subscribe|embed|authors|changelog|custom)(\/|$)/;

export function isTrackedPath(pathname) {
	return !UNTRACKED_PATH.test(pathname);
}

export function isPublicPagePath(pathname, { isSignedIn = false } = {}) {
	return PUBLIC_PATH.test(pathname) || (pathname === "/" && !isSignedIn);
}

// An address without its query string or hash (a contacts search can hold an email address in it); a mailto: or tel:
// link without anything.
export function stripUrl(value) {
	if (typeof value !== "string") return value;
	if (/^(mailto|tel):/i.test(value.trim())) return "";
	return value.replace(/[?#][\s\S]*$/, "");
}

// Autocapture's element chain, a string: the text of each element and the addresses its links lead to.
function scrubChain(chain, keepText) {
	let text = String(chain);
	if (!keepText) text = text.replace(/text="(?:[^"\\]|\\.)*"/g, 'text=""');
	return text
		.replace(/(attr__href|href)="((?:[^"\\]|\\.)*)"/g, (_, key, value) => `${key}="${stripUrl(value)}"`)
		.replace(/attr__(aria-label|title|value|alt|placeholder)="(?:[^"\\]|\\.)*"/g, 'attr__$1=""');
}

function scrubElement(element, keepText) {
	const clean = {};
	for (const [key, value] of Object.entries(element)) {
		if (PRIVATE_ATTRIBUTES.test(key)) continue;
		if ((key === "$el_text" || key === "text") && !keepText) continue;
		clean[key] = URL_KEY.test(key) ? stripUrl(value) : value;
	}
	return clean;
}

function scrubProperties(properties, keepText) {
	const clean = {};
	for (const [key, value] of Object.entries(properties ?? {})) {
		if (key === "$el_text" && !keepText) continue;
		if ((key === "title" || key === "$title") && !keepText) continue;
		if (key === "$elements_chain") clean[key] = scrubChain(value, keepText);
		else if (key === "$elements" && Array.isArray(value)) clean[key] = value.map((element) => scrubElement(element, keepText));
		else if (URL_KEY.test(key)) clean[key] = stripUrl(value);
		else clean[key] = value;
	}
	return clean;
}

// PostHog's before_send: runs on every event just before it goes. Returns the event cleaned, or null to not send it.
// Session recording's snapshots pass through untouched when it is on (its own masking applies there).
export function sanitizeEvent(event, { isSignedIn = false, replay = false } = {}) {
	if (!event || typeof event.event !== "string") return null;
	if (event.event === "$snapshot") return replay ? event : null;
	if (!BUILT_IN_EVENTS.has(event.event) && !Object.hasOwn(EVENTS, event.event)) return null;

	let pathname = "";
	try {
		pathname = new URL(String(event.properties?.$current_url)).pathname;
	} catch {
		// No usable address: treat the page as one that keeps no text.
	}
	if (pathname && !isTrackedPath(pathname)) return null;
	const keepText = pathname !== "" && isPublicPagePath(pathname, { isSignedIn });

	const clean = { ...event, properties: scrubProperties(event.properties, keepText) };
	for (const key of ["$set", "$set_once"]) {
		if (event[key]) clean[key] = scrubProperties(event[key], keepText);
	}
	return clean;
}
