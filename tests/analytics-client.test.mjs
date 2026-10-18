import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { GOAL_EVENT, reportGoal } from "../lib/goals.js";
import { buildConfig, createAnalytics, takeGoalCookie } from "../lib/marketing/analytics-client.js";

// The browser side of FlockStack's PostHog with a stand-in for posthog-js: what it loads and when, how it is set up,
// who it identifies, what happens on a decline, a sign-out and a route change.
const SETTINGS = { token: "phc_exampleprojectkey0123456789", host: "https://us.i.posthog.com", region: "us" };
const PERSON = { id: "user_1", email: "ada@example.com", plan: "starter" };

function fakePosthog({ optedOut = false, distinctId = "anon-1" } = {}) {
	const calls = [];
	const record = (name) => (...args) => {
		calls.push([name, ...args]);
	};
	const client = {
		calls,
		config: null,
		isOptedOut: optedOut,
		init(token, config) {
			calls.push(["init", token]);
			client.config = config;
		},
		has_opted_out_capturing: () => client.isOptedOut,
		opt_in_capturing(options) {
			calls.push(["opt_in_capturing", options]);
			client.isOptedOut = false;
		},
		opt_out_capturing() {
			calls.push(["opt_out_capturing"]);
			client.isOptedOut = true;
		},
		get_distinct_id: () => distinctId,
		identify: record("identify"),
		setPersonProperties: record("setPersonProperties"),
		register: record("register"),
		capture: record("capture"),
		reset: record("reset"),
		stopSessionRecording: record("stopSessionRecording"),
		startSessionRecording: record("startSessionRecording"),
	};
	return client;
}

// A document.cookie that keeps a jar: a write with Max-Age=0 removes the cookie, any other adds it.
function fakeDocument(cookies) {
	const jar = new Map(Object.entries(cookies));
	return {
		get cookie() {
			return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
		},
		set cookie(line) {
			const [pair, ...attributes] = line.split(";").map((part) => part.trim());
			const [name, value] = pair.split("=");
			if (attributes.includes("Max-Age=0")) jar.delete(name);
			else jar.set(name, value);
		},
	};
}

function setup({ posthog = fakePosthog() } = {}) {
	let loads = 0;
	const document = fakeDocument({ ph_phc_exampleprojectkey0123456789_posthog: "x", fs_consent: "accepted" });
	const analytics = createAnalytics({
		load: async () => {
			loads += 1;
			return posthog;
		},
		browser: () => ({ document, storages: [], hostname: "flockstack.io", isSecure: true }),
	});
	return { analytics, posthog, document, loads: () => loads, names: () => posthog.calls.map(([name]) => name) };
}

describe("starting", () => {
	test("loads nothing until start is called", () => {
		const { analytics, loads } = setup();
		assert.equal(loads(), 0);
		assert.equal(analytics.isRunning(), false);
		assert.equal(analytics.track("campaign_sent", { when: "now" }), false);
	});

	test("sets posthog-js up for page views with route changes, autocapture and no session recording", async () => {
		const { analytics, posthog } = setup();
		await analytics.start(SETTINGS);
		const { config } = posthog;
		assert.equal(posthog.calls[0][1], SETTINGS.token);
		assert.equal(config.api_host, "https://us.i.posthog.com");
		assert.equal(config.person_profiles, "identified_only");
		assert.equal(config.capture_pageview, "history_change");
		assert.notEqual(config.autocapture, false);
		assert.equal(config.autocapture.capture_copied_text, false);
		assert.ok(config.autocapture.css_selector_ignorelist.includes("[contenteditable]"));
		assert.equal(config.disable_session_recording, true);
		assert.equal(config.session_recording, undefined);
		assert.deepEqual(posthog.calls.find(([name]) => name === "register"), ["register", { region: "us" }]);
		assert.equal(analytics.isRunning(), true);
	});

	test("loads no more scripts and records no request addresses", () => {
		const config = buildConfig({ host: SETTINGS.host });
		for (const name of ["capture_dead_clicks", "capture_heatmaps", "capture_exceptions", "capture_performance"]) assert.equal(config[name], false, name);
		for (const name of ["disable_surveys", "disable_product_tours", "disable_conversations", "disable_web_experiments"]) assert.equal(config[name], true, name);
		assert.equal(config.cross_subdomain_cookie, false);
		assert.equal(config.secure_cookie, true);
		assert.equal(config.respect_dnt, true);
		assert.equal(buildConfig({ host: SETTINGS.host, isSecure: false }).secure_cookie, false);
	});

	test("turns session recording on only when asked, with every input and every text masked", () => {
		const config = buildConfig({ host: SETTINGS.host, replay: true });
		assert.equal(config.disable_session_recording, false);
		assert.equal(config.session_recording.maskAllInputs, true);
		assert.equal(config.session_recording.maskTextSelector, "*");
		for (const type of ["password", "email", "text", "tel", "textarea", "select"]) assert.equal(config.session_recording.maskInputOptions[type], true, type);
		assert.equal(buildConfig({ host: SETTINGS.host }).disable_session_recording, true);
	});

	test("sends every event through the scrubber", () => {
		const { before_send: beforeSend } = buildConfig({ host: SETTINGS.host, identity: PERSON });
		assert.equal(beforeSend({ event: "$pageview", properties: { $current_url: "https://flockstack.io/recommendations" } }), null);
		const kept = beforeSend({ event: "$autocapture", properties: { $current_url: "https://flockstack.io/contacts?q=ada@example.com", $el_text: "ada@example.com" } });
		assert.deepEqual(kept.properties, { $current_url: "https://flockstack.io/contacts" });
	});

	test("starting twice loads posthog-js once", async () => {
		const { analytics, loads, names } = setup();
		await Promise.all([analytics.start(SETTINGS), analytics.start(SETTINGS)]);
		assert.equal(loads(), 2);
		assert.equal(names().filter((name) => name === "init").length, 1);
	});
});

describe("a signed-in person", () => {
	test("is identified by user ID, with their email and plan as properties and nothing else", async () => {
		const { analytics, posthog } = setup();
		await analytics.start({ ...SETTINGS, identity: { ...PERSON, name: "Ada", newsletter: "Field notes" } });
		assert.deepEqual(posthog.calls.find(([name]) => name === "identify"), ["identify", "user_1", { email: "ada@example.com", plan: "starter" }]);
		assert.deepEqual(posthog.config.bootstrap, { distinctID: "user_1", isIdentifiedID: true });
	});

	test("is not identified a second time, and a changed plan updates the person", async () => {
		const { analytics, posthog } = setup({ posthog: fakePosthog({ distinctId: "user_1" }) });
		await analytics.start({ ...SETTINGS, identity: PERSON });
		await analytics.start({ ...SETTINGS, identity: PERSON });
		await analytics.start({ ...SETTINGS, identity: { ...PERSON, plan: "growth" } });
		assert.equal(posthog.calls.filter(([name]) => name === "identify").length, 0);
		assert.deepEqual(
			posthog.calls.filter(([name]) => name === "setPersonProperties"),
			[
				["setPersonProperties", { email: "ada@example.com", plan: "starter" }],
				["setPersonProperties", { email: "ada@example.com", plan: "growth" }],
			]
		);
	});

	test("a visitor who isn't signed in is never identified", async () => {
		const { analytics, names } = setup();
		await analytics.start(SETTINGS);
		assert.ok(!names().includes("identify"));
		assert.ok(!names().includes("setPersonProperties"));
	});

	test("signing out resets PostHog, and the next person isn't this one", async () => {
		const { analytics, names } = setup();
		await analytics.start({ ...SETTINGS, identity: PERSON });
		analytics.reset();
		assert.equal(names().filter((name) => name === "reset").length, 1);
		await analytics.start({ ...SETTINGS, identity: PERSON });
		assert.equal(names().filter((name) => name === "identify").length, 2);
	});
});

describe("explicit events", () => {
	test("track sends a listed event with its listed properties", async () => {
		const { analytics, posthog } = setup();
		await analytics.start(SETTINGS);
		assert.equal(analytics.track("campaign_sent", { when: "scheduled", subject: "Hi", email: "ada@example.com" }), true);
		assert.equal(analytics.track("signup_completed"), true);
		assert.equal(analytics.track("onboarding_completed"), true);
		assert.equal(analytics.track("page_viewed"), false);
		assert.deepEqual(
			posthog.calls.filter(([name]) => name === "capture"),
			[
				["capture", "campaign_sent", { when: "scheduled" }],
				["capture", "signup_completed", {}],
				["capture", "newsletter_created", {}],
			]
		);
	});

	test("reportGoal on the window is what ProviderAnalytics turns into track", () => {
		const events = [];
		const fakeWindow = { dispatchEvent: (event) => events.push(event) };
		globalThis.window = fakeWindow;
		try {
			reportGoal("campaign_sent", { when: "now" });
		} finally {
			delete globalThis.window;
		}
		assert.equal(events.length, 1);
		assert.equal(events[0].type, GOAL_EVENT);
		assert.deepEqual(events[0].detail, { goal: "campaign_sent", props: { when: "now" } });
		assert.doesNotThrow(() => reportGoal("campaign_sent"));
	});

	test("the step the server left in a cookie is read once and removed", () => {
		const document = fakeDocument({ theme: "dark", fs_goal: "signup_completed", fs_consent: "accepted" });
		assert.equal(takeGoalCookie(document), "signup_completed");
		assert.equal(document.cookie, "theme=dark; fs_consent=accepted");
		assert.equal(takeGoalCookie({ cookie: "theme=dark" }), null);
		assert.equal(takeGoalCookie({ cookie: "fs_goal_old=signup_completed" }), null);
	});
});

describe("stopping", () => {
	test("a decline before PostHog ever loaded removes its cookies and loads nothing", () => {
		const { analytics, document, loads } = setup();
		analytics.stop();
		assert.equal(loads(), 0);
		assert.doesNotMatch(document.cookie, /ph_phc/);
		assert.match(document.cookie, /fs_consent=accepted/);
	});

	test("a decline while it runs opts out, stops recording and sends nothing more", async () => {
		const { analytics, posthog, document } = setup();
		await analytics.start(SETTINGS);
		analytics.stop();
		assert.ok(posthog.calls.some(([name]) => name === "opt_out_capturing"));
		assert.ok(posthog.calls.some(([name]) => name === "stopSessionRecording"));
		assert.doesNotMatch(document.cookie, /ph_phc/);
		assert.equal(analytics.isRunning(), false);
		assert.equal(analytics.track("signup_completed"), false);
	});

	test("accepting again resumes the same client and opts it back in without an event of its own", async () => {
		const { analytics, posthog, loads } = setup();
		await analytics.start(SETTINGS);
		analytics.stop();
		await analytics.start(SETTINGS);
		assert.equal(loads(), 1);
		assert.deepEqual(posthog.calls.findLast(([name]) => name === "opt_in_capturing"), ["opt_in_capturing", { captureEventName: false }]);
		assert.equal(analytics.track("plan_started"), true);
	});

	test("a page change to a page without analytics pauses it without removing anything", async () => {
		const { analytics, posthog, document } = setup();
		await analytics.start(SETTINGS);
		analytics.pause();
		assert.ok(posthog.calls.some(([name]) => name === "opt_out_capturing"));
		assert.match(document.cookie, /ph_phc/);
		assert.equal(analytics.track("signup_completed"), false);
		await analytics.start(SETTINGS);
		assert.equal(analytics.track("signup_completed"), true);
	});

	test("a start that finishes loading after a decline doesn't set posthog-js up", async () => {
		let release;
		const posthog = fakePosthog();
		const analytics = createAnalytics({
			load: () => new Promise((resolve) => (release = () => resolve(posthog))),
			browser: () => ({ document: { cookie: "" }, storages: [], hostname: "flockstack.io", isSecure: true }),
		});
		const started = analytics.start(SETTINGS);
		analytics.stop();
		release();
		await started;
		assert.deepEqual(posthog.calls, []);
	});

	test("a client that was left opted out by an earlier page is opted back in when the visitor accepts", async () => {
		const { analytics, posthog } = setup({ posthog: fakePosthog({ optedOut: true }) });
		await analytics.start(SETTINGS);
		assert.ok(posthog.calls.some(([name]) => name === "opt_in_capturing"));
		assert.equal(analytics.track("signup_completed"), true);
	});
});
