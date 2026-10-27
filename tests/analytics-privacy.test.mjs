import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	EVENTS,
	FORBIDDEN_PROPERTY_PATTERN,
	GOAL_EVENTS,
	PERSON_PROPERTIES,
	SESSION_PROPERTIES,
	SIGNUP_SOURCES,
	SUPER_PROPERTIES,
	isTrackedPath,
	sanitizeEvent,
	stripUrl,
	toEvent,
	toPersonProperties,
	toSignupSource,
} from "../lib/marketing/analytics-privacy.js";

// What FlockStack's PostHog may carry: no newsletter content, no subscriber or contact data. The names of every property
// are fixed here, the events are a short list, and what PostHog collects itself is scrubbed before it leaves.
const ROOT = fileURLToPath(new URL("../", import.meta.url));

async function sourceFiles(dir) {
	const files = [];
	for (const entry of await readdir(join(ROOT, dir), { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
		else if (/\.(js|jsx|mjs)$/.test(entry.name)) files.push(path);
	}
	return files;
}

const pageview = (url, extra = {}) => ({ event: "$pageview", properties: { $current_url: url, title: "Some page", ...extra } });

describe("the property names", () => {
	test("an event carries at most a few fixed properties, none of them named for content or contacts", () => {
		assert.deepEqual(Object.keys(EVENTS), ["signup_started", "signup_completed", "newsletter_created", "campaign_sent", "plan_started", "support_opened", "support_answered"]);
		for (const [event, properties] of Object.entries(EVENTS)) {
			for (const [name, values] of Object.entries(properties)) {
				assert.doesNotMatch(name, FORBIDDEN_PROPERTY_PATTERN, `${event}.${name}`);
				assert.doesNotMatch(name, /email/i, `${event}.${name}`);
				assert.ok(Array.isArray(values) && values.length > 0 && values.every((value) => typeof value === "string" && value.length < 20), `${event}.${name} lists its values`);
			}
		}
		assert.deepEqual(EVENTS.campaign_sent, { when: ["now", "scheduled"] });
	});

	test("a person is an ID with an email and a plan, and every event says which deployment", () => {
		assert.deepEqual(PERSON_PROPERTIES, ["email", "plan"]);
		assert.deepEqual(SUPER_PROPERTIES, ["region"]);
		for (const name of SUPER_PROPERTIES) assert.doesNotMatch(name, FORBIDDEN_PROPERTY_PATTERN);
		assert.deepEqual(toPersonProperties({ id: "u1", email: "ada@example.com", plan: "starter", name: "Ada", newsletter: "Field notes" }), { email: "ada@example.com", plan: "starter" });
		assert.deepEqual(toPersonProperties({ email: "ada@example.com" }), { email: "ada@example.com", plan: "none" });
	});

	test("the forbidden pattern catches what a creator or a reader wrote", () => {
		for (const name of ["subject", "body", "html", "content", "title", "contact_email", "subscriber_count", "recipient", "newsletter_name", "comment", "draft", "audience", "segment", "password", "api_key"]) {
			assert.match(name, FORBIDDEN_PROPERTY_PATTERN, name);
		}
		for (const name of ["when", "plan", "region", "step"]) assert.doesNotMatch(name, FORBIDDEN_PROPERTY_PATTERN, name);
	});

	test("every goal the server or the browser reports is one of the events", () => {
		for (const event of Object.values(GOAL_EVENTS)) assert.ok(Object.hasOwn(EVENTS, event), event);
	});
});

describe("where a sign-up came from", () => {
	test("only a button the website names counts, each a short fixed name", () => {
		assert.ok(SIGNUP_SOURCES.length > 0);
		for (const name of SIGNUP_SOURCES) assert.match(name, /^[a-z0-9][a-z0-9-]{0,18}$/, name);
		assert.equal(new Set(SIGNUP_SOURCES).size, SIGNUP_SOURCES.length);
		assert.equal(toSignupSource("hero-primary"), "hero-primary");
		for (const value of ["", "Hero-Primary", "hero-primary?x=1", "ada@example.com", "constructor", "__proto__", undefined, null, ["hero-primary"], 5]) assert.equal(toSignupSource(value), null, String(value));
	});

	test("signup_started carries that name and nothing else, and the session keeps one property for it", () => {
		assert.deepEqual(EVENTS.signup_started, { cta: SIGNUP_SOURCES });
		assert.deepEqual(toEvent("signup_started", { cta: "plan-starter", email: "ada@example.com" }), { name: "signup_started", props: { cta: "plan-starter" } });
		assert.deepEqual(toEvent("signup_started", { cta: "ada@example.com" }), { name: "signup_started", props: {} });
		assert.deepEqual(SESSION_PROPERTIES, ["signup_cta"]);
		for (const name of SESSION_PROPERTIES) assert.doesNotMatch(name, FORBIDDEN_PROPERTY_PATTERN);
	});

	test("the sign-in page reaches PostHog through the extension with the raw ?cta=, which SiteAnalytics checks", async () => {
		const page = await readFile(join(ROOT, "app/signin/page.js"), "utf8");
		assert.match(page, /<SiteAnalytics signupSource=\{params\.cta\} \/>/);
		assert.doesNotMatch(page, /lib\/marketing/);
		const site = await readFile(join(ROOT, "components/marketing/SiteAnalytics.jsx"), "utf8");
		assert.match(site, /toSignupSource\(signupSource\)/);
		assert.match(site, /\.\.\.\(source && \{ signupSource: source \}\)/);
	});
});

describe("track and the goals", () => {
	test("keep a listed event and its listed properties, and drop everything else", () => {
		assert.deepEqual(toEvent("campaign_sent", { when: "now" }), { name: "campaign_sent", props: { when: "now" } });
		assert.deepEqual(toEvent("campaign_sent", { when: "scheduled", subject: "Hello", email: "ada@example.com", count: 12 }), { name: "campaign_sent", props: { when: "scheduled" } });
		assert.deepEqual(toEvent("campaign_sent", { when: "<script>" }), { name: "campaign_sent", props: {} });
		assert.deepEqual(toEvent("signup_completed", { email: "ada@example.com", plan: "starter" }), { name: "signup_completed", props: {} });
		assert.deepEqual(toEvent("onboarding_completed"), { name: "newsletter_created", props: {} });
		assert.deepEqual(toEvent("plan_started", null), { name: "plan_started", props: {} });
	});

	test("ignore a step that isn't counted", () => {
		for (const goal of ["page_viewed", "constructor", "__proto__", "toString", "", undefined, null, "signup_failed"]) assert.equal(toEvent(goal, {}), null, String(goal));
	});

	test("the code calls them only with names from the list", async () => {
		const names = new Set();
		for (const dir of ["app", "components", "lib"]) {
			for (const file of await sourceFiles(dir)) {
				const text = await readFile(join(ROOT, file), "utf8");
				for (const [, call, name] of text.matchAll(/\b(reportGoal|sendGoalOnNextPage|analytics\.track|track)\(\s*"([^"]+)"/g)) {
					if (call === "track" && !file.includes("analytics")) continue;
					names.add(name);
					assert.ok(Object.hasOwn(GOAL_EVENTS, name), `${file} reports ${name}`);
				}
			}
		}
		for (const name of ["campaign_sent", "newsletter_created", "plan_started", "signup_completed", "onboarding_completed", "signup_started"]) assert.ok(names.has(name), `${name} is reported somewhere`);
	});

	test("posthog-js is imported in one file, and nothing else captures an event or sets a person's property", async () => {
		const importers = [];
		for (const dir of ["app", "components", "lib"]) {
			for (const file of await sourceFiles(dir)) {
				const text = await readFile(join(ROOT, file), "utf8");
				if (/(from\s+|import\(\s*)["']posthog-js/.test(text)) importers.push(file);
				if (!file.endsWith("lib/marketing/analytics-client.js")) assert.doesNotMatch(text, /\bposthog\.(capture|identify|setPersonProperties|register|set_config)\b/, file);
			}
		}
		assert.deepEqual(importers, ["lib/marketing/analytics-client.js"]);
	});
});

describe("what PostHog collects by itself", () => {
	test("loses the query string and hash of every address, where a search can hold an email address", () => {
		const event = sanitizeEvent(
			pageview("https://flockstack.io/contacts?q=ada%40example.com#top", {
				$referrer: "https://flockstack.io/contacts?q=grace@example.com",
				$initial_referrer: "https://www.google.com/search?q=flockstack",
				$pathname: "/contacts",
			}),
			{ isSignedIn: true }
		);
		assert.equal(event.properties.$current_url, "https://flockstack.io/contacts");
		assert.equal(event.properties.$referrer, "https://flockstack.io/contacts");
		assert.equal(event.properties.$initial_referrer, "https://www.google.com/search");
		assert.equal(event.properties.$pathname, "/contacts");
		assert.doesNotMatch(JSON.stringify(event), /example\.com|ada|grace|%40/);
		assert.equal(stripUrl("mailto:ada@example.com"), "");
		assert.equal(stripUrl("/campaigns/abc?tab=send#x"), "/campaigns/abc");
		assert.equal(stripUrl("tel:+15555550100"), "");
	});

	test("cleans the person's properties the same way", () => {
		const event = sanitizeEvent({ ...pageview("https://flockstack.io/docs?utm_source=x"), $set: { $current_url: "https://flockstack.io/docs?utm_source=x", email: "ada@example.com" }, $set_once: { $initial_current_url: "https://flockstack.io/?ref=a" } });
		assert.equal(event.$set.$current_url, "https://flockstack.io/docs");
		assert.equal(event.$set.email, "ada@example.com");
		assert.equal(event.$set_once.$initial_current_url, "https://flockstack.io/");
	});

	test("sends no text from the dashboard: a link or a button there can be a contact's email or an issue's subject", () => {
		const click = (url) => ({
			event: "$autocapture",
			properties: {
				$current_url: url,
				$el_text: "ada@example.com",
				title: "Welcome issue · FlockStack",
				$elements_chain: 'a.row:attr__href="/contacts/abc?q=ada@example.com"href="/contacts/abc?q=ada@example.com"nth-child="2"text="ada@example.com"attr__aria-label="Open Ada"attr__data-goal="signup_started";td:text="Ada"',
				$elements: [{ tag_name: "a", $el_text: "ada@example.com", text: "ada@example.com", attr__href: "mailto:ada@example.com", "attr__aria-label": "Open Ada", attr__class: "row", "attr__data-goal": "x" }],
			},
		});
		const event = sanitizeEvent(click("https://flockstack.io/contacts"), { isSignedIn: true });
		assert.equal(event.properties.$el_text, undefined);
		assert.equal(event.properties.title, undefined);
		assert.doesNotMatch(JSON.stringify(event), /ada|example\.com/i);
		assert.match(event.properties.$elements_chain, /a\.row/);
		assert.match(event.properties.$elements_chain, /attr__data-goal="signup_started"/);
		assert.deepEqual(event.properties.$elements, [{ tag_name: "a", attr__href: "", attr__class: "row", "attr__data-goal": "x" }]);
		for (const path of ["/", "/campaigns/abc", "/newsletters", "/billing", "/welcome"]) {
			assert.equal(sanitizeEvent(click(`https://flockstack.io${path}`), { isSignedIn: true }).properties.$el_text, undefined, path);
		}
	});

	test("keeps the text of clicks on the marketing pages, the docs, the legal pages and sign-in", () => {
		const click = (path, isSignedIn) =>
			sanitizeEvent({ event: "$autocapture", properties: { $current_url: `https://flockstack.io${path}`, $el_text: "Get started", title: "FlockStack" } }, { isSignedIn }).properties;
		for (const path of ["/docs", "/docs/api", "/privacy", "/terms", "/sub-processors", "/signin"]) assert.equal(click(path, false).$el_text, "Get started", path);
		assert.equal(click("/", false).$el_text, "Get started");
		assert.equal(click("/", true).$el_text, undefined);
		assert.equal(click("/docs", true).title, "FlockStack");
	});

	test("sends only page views, clicks, sign-ins and the explicit events", () => {
		for (const name of ["$pageview", "$pageleave", "$autocapture", "$identify", "$set", "$rageclick", ...Object.keys(EVENTS)]) {
			assert.ok(sanitizeEvent({ event: name, properties: { $current_url: "https://flockstack.io/docs" } }), name);
		}
		for (const name of ["$exception", "$web_vitals", "$dead_click", "$copy_autocapture", "$performance_event", "$snapshot", "$feature_flag_called", "my custom event", "", undefined]) {
			assert.equal(sanitizeEvent({ event: name, properties: {} }), null, String(name));
		}
		assert.ok(sanitizeEvent({ event: "$snapshot", properties: { $snapshot_data: [] } }, { replay: true }));
		assert.equal(sanitizeEvent(null), null);
	});

	test("sends nothing from a page where analytics never runs, even if the browser navigates there", () => {
		for (const path of ["/recommendations", "/recommendations?q=x", "/archive/field-notes", "/archive/field-notes/p/hello", "/reader/in", "/reader/replies", "/unsubscribe", "/confirm", "/keep", "/referral", "/p/hello", "/o/abc", "/c/abc", "/admin", "/oauth/consent", "/restore", "/api/v1/contacts"]) {
			assert.equal(isTrackedPath(path.split("?")[0]), false, path);
			assert.equal(sanitizeEvent(pageview(`https://flockstack.io${path}`)), null, path);
		}
		for (const path of ["/", "/docs", "/docs/api", "/privacy", "/signin", "/welcome", "/campaigns", "/contacts", "/recommending", "/billing", "/account", "/api-keys"]) {
			assert.equal(isTrackedPath(path), true, path);
		}
	});

	test("lets session recording snapshots through only while it is on", () => {
		assert.equal(sanitizeEvent({ event: "$snapshot", properties: {} }, { replay: false }), null);
		assert.deepEqual(sanitizeEvent({ event: "$snapshot", properties: { $snapshot_data: [1] } }, { replay: true }).properties, { $snapshot_data: [1] });
	});
});
