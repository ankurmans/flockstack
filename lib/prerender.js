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

// What one marker, with its quotes and whether they were escaped by a backslash (inside Next.js's JSON), is replaced with.
// values: { token, host, replay, requiresConsent, consent }, with consent "accepted", "declined" or null.
export function replacementFor(marker, isEscaped, values) {
	const quote = isEscaped ? '\\"' : '"';
	switch (marker) {
		case ANALYTICS_MARKERS.token:
			return `${quote}${values.token}${quote}`;
		case ANALYTICS_MARKERS.host:
			return `${quote}${values.host}${quote}`;
		case ANALYTICS_MARKERS.replay:
			return String(Boolean(values.replay));
		case ANALYTICS_MARKERS.requiresConsent:
			return String(Boolean(values.requiresConsent));
		case ANALYTICS_MARKERS.consent:
			return values.consent == null ? "null" : `${quote}${values.consent}${quote}`;
		default:
			throw new Error(`Not an analytics marker: ${marker}`);
	}
}

// Puts the visitor's values where the markers are, in a page held as text.
export function fillAnalyticsMarkers(text, values) {
	return text.replace(ANALYTICS_MARKER_PATTERN, (match, marker) => replacementFor(marker, match.startsWith("\\"), values));
}

// The page as a stream with the replacements made: the same bytes as fillAnalyticsMarkers gives, however the page is cut up.
export function fillMarkerStream(body, replacements, values) {
	const encoder = new TextEncoder();
	const pieces = replacements.map(([start, end, marker, isEscaped]) => ({ start, end, bytes: encoder.encode(replacementFor(marker, Boolean(isEscaped), values)) }));
	let position = 0;
	let next = 0;
	let skipTo = 0;
	return body.pipeThrough(
		new TransformStream({
			transform(chunk, controller) {
				const chunkStart = position;
				const chunkEnd = position + chunk.length;
				position = chunkEnd;
				let cursor = Math.max(chunkStart, skipTo);
				if (cursor >= chunkEnd) return;
				while (next < pieces.length && pieces[next].start < chunkEnd) {
					const { start, end, bytes } = pieces[next++];
					if (start > cursor) controller.enqueue(chunk.subarray(cursor - chunkStart, start - chunkStart));
					controller.enqueue(bytes);
					cursor = end;
					skipTo = end;
					if (cursor >= chunkEnd) return;
				}
				controller.enqueue(chunk.subarray(cursor - chunkStart));
			},
		})
	);
}
