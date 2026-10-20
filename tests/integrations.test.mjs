import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { callApi, startTestApp } from "./helpers/app.mjs";
import { createSeller, installFakeStripe } from "./helpers/shop.mjs";
import { flushAfter } from "./stubs/next-server.mjs";
import { published } from "./stubs/qstash.mjs";

// The Zapier and Make apps in integrations/: their events are the app's, they reach the region the connection names, and
// the Zapier app's triggers, actions and search work against the real REST API (z.request answered by the route handler).
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const zapier = (path) => require(`${ROOT}integrations/zapier/${path}`);
const readMake = async (path) => JSON.parse(await readFile(`${ROOT}integrations/make/${path}`, "utf8"));

let app;
let m;

// Zapier's z object, its requests answered by FlockStack's REST route; requests records each one as Zapier sent it.
function fakeZ(requests) {
	class ZapierError extends Error {}
	const z = {
		errors: { Error: ZapierError, RefreshAuthError: ZapierError },
		request: async ({ url, method = "GET", json, skipThrowForStatus, headers = {} }) => {
			requests.push({ url, method, json });
			const { origin, pathname, search } = new URL(url);
			assert.ok(["https://flockstack.io", "https://eu.flockstack.io", "https://news.example.com"].includes(origin), origin);
			const request = { url, method, headers, skipThrowForStatus };
			zapier("lib/api.js").addApiKey(request, z, z.bundle);
			const key = request.headers.Authorization.replace("Bearer ", "");
			const answer = await callApi(method, `${pathname}${search}`, { key, body: json });
			const response = { status: answer.status, data: answer.body, content: JSON.stringify(answer.body), request };
			return zapier("lib/api.js").handleErrors(response, z);
		},
	};
	return z;
}

before(async () => {
	app = await startTestApp({ QSTASH_CURRENT_SIGNING_KEY: "sig-current", QSTASH_NEXT_SIGNING_KEY: "sig-next" });
	m = {
		events: await import("../lib/webhook-events.js"),
		webhooks: await import("../lib/webhooks.js"),
		WebhookEndpoint: (await import("../models/WebhookEndpoint.js")).default,
	};
	installFakeStripe();
});

after(() => app?.stop());

describe("Zapier", () => {
	test("has a trigger for every event, and reaches the connection's region or server", () => {
		const events = zapier("lib/events.js");
		assert.deepEqual(events.map(({ type }) => type), m.events.WEBHOOK_EVENT_TYPES);
		const { getBaseUrl } = zapier("lib/api.js");
		assert.equal(getBaseUrl({ region: "us" }), "https://flockstack.io");
		assert.equal(getBaseUrl({ region: "eu" }), "https://eu.flockstack.io");
		assert.equal(getBaseUrl({ region: "eu", serverUrl: "https://news.example.com/" }), "https://news.example.com");
		const auth = zapier("authentication.js");
		assert.deepEqual(auth.fields.map(({ key }) => key), ["apiKey", "region", "serverUrl"]);
	});

	test("turning a Zap on adds an endpoint for its event, events reach the Zap, and turning it off deletes it", async () => {
		const user = await createSeller("zapier@example.com");
		const requests = [];
		const z = fakeZ(requests);
		const { makeEventTrigger } = zapier("triggers/event.js");
		const trigger = makeEventTrigger(zapier("lib/events.js")[0]);
		const bundle = { authData: { apiKey: user.key, region: "us" }, inputData: { newsletter: user.newsletterId }, targetUrl: "https://hooks.zapier.com/hooks/standard/1/abc/" };
		z.bundle = bundle;

		const subscribeData = await trigger.operation.performSubscribe(z, bundle);
		const stored = await m.WebhookEndpoint.findOne({ accountId: user.accountId, _id: subscribeData.id }).lean();
		assert.deepEqual([stored.url, stored.events, stored.source, String(stored.newsletterId)], [bundle.targetUrl, ["subscriber.created"], "zapier", user.newsletterId]);

		const sample = await trigger.operation.performList(z, bundle);
		assert.ok(Array.isArray(sample));

		await callApi("POST", "/api/v1/contacts", { key: user.key, body: { email: "zap@example.com" } });
		await flushAfter();
		const job = published.findLast(({ url }) => url.endsWith("/api/jobs/deliver-webhook"));
		let delivered;
		await m.webhooks.deliverWebhook(job.body, { fetchImpl: async (url, init) => ((delivered = JSON.parse(init.body)), new Response("ok")) });
		const [item] = trigger.operation.perform(z, { ...bundle, cleanedRequest: delivered });
		assert.deepEqual([item.email, item.event, item.status], ["zap@example.com", "subscriber.created", "active"]);
		assert.match(item.id, /^subscriber\.created:[0-9a-f]{24}:/);

		await trigger.operation.performUnsubscribe(z, { ...bundle, subscribeData });
		assert.equal(await m.WebhookEndpoint.countDocuments({ accountId: user.accountId }), 0);
		await trigger.operation.performUnsubscribe(z, { ...bundle, subscribeData });
		assert.deepEqual(requests.at(-1), { url: `https://flockstack.io/api/v1/webhooks/${subscribeData.id}`, method: "DELETE", json: undefined });
	});

	test("adds and updates subscribers, tags them, and finds them by email", async () => {
		const user = await createSeller("zapier-actions@example.com");
		const z = fakeZ([]);
		const bundle = { authData: { apiKey: user.key, region: "us" } };
		z.bundle = bundle;
		const run = (operation, inputData) => operation.operation.perform(z, { ...bundle, inputData });

		const added = await run(zapier("creates/add-subscriber.js"), { email: "jane@example.com", tags: ["from zapier"] });
		assert.deepEqual([added.email, added.created, added.tags], ["jane@example.com", true, ["from zapier"]]);
		const updated = await run(zapier("creates/update-subscriber.js"), { email: "jane@example.com", tags: ["vip"] });
		assert.deepEqual([updated.created, updated.tags], [false, ["from zapier", "vip"]]);
		const tagged = await run(zapier("creates/add-tag.js"), { subscriber: "jane@example.com", tag: "launch" });
		assert.deepEqual(tagged.tags, ["from zapier", "vip", "launch"]);

		const [found] = await run(zapier("searches/find-subscriber.js"), { email: "jane@example.com" });
		assert.equal(found.id, added.id);
		assert.deepEqual(await run(zapier("searches/find-subscriber.js"), { email: "nobody@example.com" }), []);
		await assert.rejects(run(zapier("creates/add-subscriber.js"), { email: "not an address" }), /email is invalid/);
	});
});

describe("Make", () => {
	test("lists every event, and every component's files exist", async () => {
		const parameters = await readMake("webhooks/flockstack/parameters.iml.json");
		assert.deepEqual(parameters.find(({ name }) => name === "event").options.map(({ value }) => value), m.events.WEBHOOK_EVENT_TYPES);
		const manifest = await readMake("makecomapp.json");
		const files = [manifest.generalCodeFiles.base, ...Object.values(manifest.components).flatMap((group) => Object.values(group).flatMap(({ codeFiles }) => Object.values(codeFiles)))];
		for (const file of files) await readMake(file);
	});

	test("reaches the connection's region or server, subscribes with create_webhook_endpoint and unsubscribes with delete", async () => {
		const base = await readMake("general/base.iml.json");
		for (const text of [base.baseUrl, (await readMake("webhooks/flockstack/attach.iml.json")).url, (await readMake("connections/flockstack/api.iml.json")).url]) {
			assert.match(text, /https:\/\/eu\.flockstack\.io/);
			assert.match(text, /https:\/\/flockstack\.io/);
			assert.match(text, /serverUrl/);
		}
		const attach = await readMake("webhooks/flockstack/attach.iml.json");
		assert.deepEqual([attach.method, attach.body.source, attach.body.events], ["POST", "make", ["{{parameters.event}}"]]);
		assert.match(attach.url, /\/api\/v1\/webhooks$/);
		const detach = await readMake("webhooks/flockstack/detach.iml.json");
		assert.equal(detach.method, "DELETE");
		assert.match(detach.url, /\/api\/v1\/webhooks\/\{\{webhook\.externalHookId\}\}$/);
		assert.equal(base.headers.Authorization, "Bearer {{connection.apiKey}}");
	});
});
