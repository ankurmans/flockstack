// The public pages Worker (workers/public) serves pages that scripts/build-public.mjs rendered once, at deploy time, from this
// same app. A few things in those pages differ for every visitor and are only known per request: whether the visitor must
// consent to analytics (their country), the consent they saved in a cookie, and the analytics key. While the pages are rendered
// for the files (FLOCKSTACK_PRERENDER=true, set by the build script and by nothing else) the analytics component prints these
// markers instead, and the Worker puts the real values in as it serves the page. No imports: the Worker bundles this module.
export const PRERENDER_ENV = "FLOCKSTACK_PRERENDER";

export function isPrerendering(env = process.env) {
	return env[PRERENDER_ENV] === "true";
}

// Each marker is one string, so it appears in the page between quotes: in the server-rendered markup's attributes, and in the
// JSON of the data Next.js sends along for the browser (escaped there).
export const ANALYTICS_MARKERS = {
	token: "FSPRERENDERTOKEN",
	host: "https://prerender.invalid",
	replay: "__fs_replay__",
	requiresConsent: "__fs_requires_consent__",
	consent: "__fs_consent__",
};

const escapeForRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

// A marker with the quotes around it, escaped by a backslash or not.
export const ANALYTICS_MARKER_PATTERN = new RegExp(`\\\\?"(${Object.values(ANALYTICS_MARKERS).map(escapeForRegExp).join("|")})\\\\?"`, "g");

// Puts the visitor's values where the markers are. values: { token, host, replay, requiresConsent, consent }, with consent
// "accepted", "declined" or null.
export function fillAnalyticsMarkers(text, values) {
	const byMarker = {
		[ANALYTICS_MARKERS.token]: { value: values.token, isString: true },
		[ANALYTICS_MARKERS.host]: { value: values.host, isString: true },
		[ANALYTICS_MARKERS.replay]: { value: Boolean(values.replay), isString: false },
		[ANALYTICS_MARKERS.requiresConsent]: { value: Boolean(values.requiresConsent), isString: false },
		[ANALYTICS_MARKERS.consent]: { value: values.consent ?? null, isString: values.consent != null },
	};
	return text.replace(ANALYTICS_MARKER_PATTERN, (match, marker) => {
		const { value, isString } = byMarker[marker];
		if (!isString) return String(value);
		const quote = match.startsWith("\\") ? '\\"' : '"';
		return `${quote}${value}${quote}`;
	});
}
