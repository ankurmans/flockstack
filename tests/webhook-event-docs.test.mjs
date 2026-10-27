import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { handleStripeEvent } from "../lib/billing.js";
import { CONNECT_EVENT_TYPES, PAYMENT_EVENT_TYPES, SELF_HOSTED_EVENT_TYPES } from "../lib/payments/event-types.js";
import { HANDLED_EVENT_TYPES } from "../lib/payments/events.js";

// The Stripe events an owner is told to turn on must be the ones the handlers act on: an event the code handles but the README
// leaves out is one a self-hoster never receives, and a pause or a voided invoice goes unseen.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), "utf8");
const sorted = (list) => [...list].sort();
const EVENT = /`((?:checkout|charge|customer|invoice|account)\.[a-z_.]+)`/g;
const eventsIn = (text) => [...text.matchAll(EVENT)].map((match) => match[1]);

describe("the payments webhook events", () => {
	test("the list the pages use is exactly what the handlers act on", () => {
		assert.deepEqual(sorted(PAYMENT_EVENT_TYPES), sorted(HANDLED_EVENT_TYPES));
		assert.equal(new Set(PAYMENT_EVENT_TYPES).size, PAYMENT_EVENT_TYPES.length, "no event twice");
		assert.deepEqual(sorted(SELF_HOSTED_EVENT_TYPES.concat(CONNECT_EVENT_TYPES)), sorted(PAYMENT_EVENT_TYPES));
		for (const type of CONNECT_EVENT_TYPES) assert.ok(type.startsWith("account."), type);
	});

	test("the README names every event a self-hosted server receives, and no other", () => {
		const line = read("README.md").split("\n").find((text) => text.includes("<APP_URL>/api/webhooks/payments"));
		assert.ok(line, "the README has the payments webhook step");
		const listed = eventsIn(line.slice(line.indexOf("<APP_URL>/api/webhooks/payments"), line.indexOf("STRIPE_PAYMENTS_WEBHOOK_SECRET")));
		assert.deepEqual(sorted(listed), sorted(SELF_HOSTED_EVENT_TYPES));
	});

	test("the selling guide lists every event, taken from the same list", () => {
		const page = read("app/(site)/docs/selling/page.js");
		assert.match(page, /import \{ PAYMENT_EVENT_TYPES \} from "@\/lib\/payments\/event-types"/);
		assert.doesNotMatch(page, /"(?:checkout|charge|customer|invoice|account)\.[a-z_.]+"/, "no event typed into the page by hand");
	});

	test("the release QA page lists every event, Connect's last", () => {
		const line = read("docs/RELEASE-QA.md").split("\n").find((text) => text.startsWith("**Webhook events to add to the endpoint**"));
		assert.ok(line, "release QA has the list");
		assert.deepEqual(sorted(eventsIn(line)), sorted(PAYMENT_EVENT_TYPES));
	});

	test("the plan billing webhook README step names the events its handler has a case for", () => {
		const cases = [...handleStripeEvent.toString().matchAll(/case "([a-z_.]+)":/g)].map((match) => match[1]);
		assert.ok(cases.length >= 5, "found the handler's cases");
		const line = read("README.md").split("\n").find((text) => text.includes("<APP_URL>/api/webhooks/stripe"));
		assert.ok(line, "the README has the plan billing webhook step");
		const listed = eventsIn(line.slice(line.indexOf("<APP_URL>/api/webhooks/stripe"), line.indexOf("STRIPE_WEBHOOK_SECRET")));
		assert.deepEqual(sorted(listed), sorted(cases));
	});
});
