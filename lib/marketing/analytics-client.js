import { clearAnalyticsStorage } from "@/lib/marketing/analytics-consent";
import { GOAL_COOKIE, sanitizeEvent, toEvent, toPersonProperties } from "@/lib/marketing/analytics-privacy";

// FlockStack's own PostHog, in the browser: the one place posthog-js is imported, and only once a visitor may be
// tracked (ProviderAnalytics decides). Until start() runs, nothing is loaded, sent or stored.

const MASKED_INPUTS = Object.fromEntries(
	"color date datetime-local email month number password range search tel text time url week textarea select".split(" ").map((type) => [type, true])
);

// posthog-js settings. Autocapture stays on; what leaves the page is scrubbed by sanitizeEvent (no text on the dashboard,
// no query strings). Session recording is off unless POSTHOG_SESSION_REPLAY is "true", and then every input and every text
// is masked. Nothing that loads more scripts (surveys, heatmaps, dead clicks) and nothing that records request URLs.
export function buildConfig({ host, replay = false, identity = null, isSignedIn = () => Boolean(identity), isSecure = true }) {
	return {
		api_host: host,
		person_profiles: "identified_only",
		capture_pageview: "history_change",
		autocapture: {
			capture_copied_text: false,
			css_selector_ignorelist: [".ph-no-capture", ".ph-no-autocapture", "[data-ph-no-autocapture]", "[contenteditable]"],
			element_attribute_ignorelist: ["aria-label", "title", "value", "alt", "placeholder"],
		},
		capture_dead_clicks: false,
		capture_heatmaps: false,
		capture_exceptions: false,
		capture_performance: false,
		disable_surveys: true,
		disable_product_tours: true,
		disable_conversations: true,
		disable_web_experiments: true,
		disable_session_recording: !replay,
		...(replay && {
			session_recording: { maskAllInputs: true, maskInputOptions: MASKED_INPUTS, maskTextSelector: "*", blockSelector: "[data-support-chat], iframe" },
		}),
		persistence: "localStorage+cookie",
		cross_subdomain_cookie: false,
		secure_cookie: isSecure,
		respect_dnt: true,
		opt_out_capturing_persistence_type: "localStorage",
		...(identity && { bootstrap: { distinctID: identity.id, isIdentifiedID: true } }),
		before_send: (event) => sanitizeEvent(event, { isSignedIn: isSignedIn(), replay }),
	};
}

function readBrowser() {
	const storages = [];
	for (const name of ["localStorage", "sessionStorage"]) {
		try {
			storages.push(globalThis[name]);
		} catch {
			// Blocked storage: nothing of ours is in it.
		}
	}
	return { document: globalThis.document, storages: storages.filter(Boolean), hostname: globalThis.location?.hostname ?? "", isSecure: globalThis.location?.protocol !== "http:" };
}

// load resolves to the posthog-js client; the browser is read when needed. Both are replaceable for tests.
export function createAnalytics({ load = () => import("posthog-js").then((module) => module.default), browser = readBrowser } = {}) {
	let client = null;
	let isWanted = false;
	let isSignedIn = false;
	let lastPerson = "";

	function clear(keepOptOut) {
		clearAnalyticsStorage({ ...browser(), keepOptOut });
	}

	function identify(identity) {
		if (!client || !isWanted || !identity) return;
		isSignedIn = true;
		const person = toPersonProperties(identity);
		const signature = `${identity.id}|${person.email}|${person.plan}`;
		if (signature === lastPerson) return;
		lastPerson = signature;
		if (client.get_distinct_id() === identity.id) client.setPersonProperties(person);
		else client.identify(identity.id, person);
	}

	// Loads posthog-js and starts it; a second call, or one after a stop, resumes the same client.
	async function start({ token, host, replay = false, region, identity = null }) {
		isWanted = true;
		isSignedIn = Boolean(identity);
		if (!client) {
			const posthog = await load();
			if (!isWanted || client) return client;
			posthog.init(token, buildConfig({ host, replay, identity, isSignedIn: () => isSignedIn, isSecure: browser().isSecure }));
			if (posthog.has_opted_out_capturing()) posthog.opt_in_capturing({ captureEventName: false });
			posthog.register({ region });
			client = posthog;
		} else if (client.has_opted_out_capturing()) {
			client.opt_in_capturing({ captureEventName: false });
			if (replay) client.startSessionRecording?.();
		}
		identify(identity);
		return client;
	}

	// The page that started it went away (a route change to a page without analytics, or to another layout's, which
	// starts it again): nothing more is captured, and nothing is cleared.
	function pause() {
		isWanted = false;
		if (!client) return;
		client.stopSessionRecording?.();
		client.opt_out_capturing();
	}

	// A declined choice, a privacy signal or no choice yet: nothing is sent and PostHog's cookies and storage are removed.
	// A client already running is told to stop first, and keeps its opt-out flag until the next page load clears that too.
	function stop() {
		isWanted = false;
		isSignedIn = false;
		lastPerson = "";
		if (client) {
			client.stopSessionRecording?.();
			client.opt_out_capturing();
		}
		clear(Boolean(client));
	}

	// One of the explicit events (lib/marketing/analytics-privacy.js): anything else, or any other property, is dropped.
	function track(goal, props) {
		const event = toEvent(goal, props);
		if (!client || !isWanted || !event) return false;
		client.capture(event.name, event.props);
		return true;
	}

	// Signing out: a new anonymous ID, so the next person on this browser isn't this one.
	function reset() {
		isSignedIn = false;
		lastPerson = "";
		client?.reset();
	}

	return { start, stop, pause, identify, track, reset, isRunning: () => Boolean(client) && isWanted };
}

export const analytics = createAnalytics();
export const track = analytics.track;

// The step the server left for this page (siteExtensions.sendGoalOnNextPage): read once and removed.
export function takeGoalCookie(doc = globalThis.document) {
	const match = new RegExp(`(?:^|;\\s*)${GOAL_COOKIE}=([\\w-]+)`).exec(doc?.cookie ?? "");
	if (!match) return null;
	doc.cookie = `${GOAL_COOKIE}=; Max-Age=0; Path=/`;
	return match[1];
}
