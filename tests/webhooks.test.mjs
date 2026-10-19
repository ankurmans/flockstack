import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { activate, anonymous, as, form, jsonRequest, platformEmails, startTestApp, withEnv } from "./helpers/app.mjs";
import { WEBHOOK_SECRET, api, assertError, buy, createProduct, createSeller, installFakeStripe, payForSession, postPaymentEvent } from "./helpers/shop.mjs";
import { flushAfter } from "./stubs/next-server.mjs";
import { published } from "./stubs/qstash.mjs";

// Outgoing webhooks: Standard Webhooks signatures, the address check, the plan's number of endpoints, the events the
// flows emit, and delivery: retries with backoff, giving up, turning a failing endpoint off and emailing its owner.
let app;
let m;
let fake;
let counter = 0;
let processed = 0;

const DAY_MS = 86_400_000;
const RECEIVER = "https://hooks.example.com/flockstack";

// The Standard Webhooks reference algorithm, written apart from lib/webhook-signing.js with node:crypto.
function referenceSignature(secret, id, timestamp, body) {
	const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
	return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

function referenceVerify(secret, headers, body) {
	const expected = referenceSignature(secret, headers["webhook-id"], headers["webhook-timestamp"], body);
	return headers["webhook-signature"].split(" ").includes(expected);
}

// Stands in for the receiving servers: answers with the next status of its list (200 when empty), records each request.
function receiver(statuses = []) {
	const requests = [];
	const fetchImpl = async (url, init) => {
		requests.push({ url, headers: init.headers, body: init.body, redirect: init.redirect });
		const status = statuses.length > 0 ? statuses.shift() : 200;
		if (status instanceof Error) throw status;
		return new Response(status === 204 ? null : `answer ${status}`, { status });
	};
	return { requests, fetchImpl };
}

function newJobs() {
	const jobs = published.slice(processed).filter(({ url }) => url.endsWith("/api/jobs/deliver-webhook"));
	processed = published.length;
	return jobs;
}

// Runs every delivery job QStash would have run by now, and the retries they queue, each at its own time.
async function runDeliveries(fetchImpl, { now = Date.now(), maxRounds = 20 } = {}) {
	const results = [];
	for (let round = 0; round < maxRounds; round++) {
		const jobs = newJobs();
		if (jobs.length === 0) break;
		for (const { body, notBefore } of jobs) {
			const at = notBefore ? Math.max(now, notBefore * 1000) : now;
			results.push(await m.webhooks.deliverWebhook(body, { fetchImpl, now: at }));
		}
	}
	return results;
}

async function seller(options = {}) {
	return createSeller(`hooks${++counter}@example.com`, { fake, ...options });
}

async function addEndpoint(user, fields = {}) {
	const response = await api(user, "POST", "/webhooks", { url: RECEIVER, ...fields });
	assert.equal(response.status, 201, JSON.stringify(response.body));
	newJobs();
	return response.body;
}

function bodiesOf(requests) {
	return requests.map(({ body }) => JSON.parse(body));
}

before(async () => {
	app = await startTestApp({ STRIPE_PAYMENTS_WEBHOOK_SECRET: WEBHOOK_SECRET, QSTASH_CURRENT_SIGNING_KEY: "sig-current", QSTASH_NEXT_SIGNING_KEY: "sig-next" });
	m = {
		signing: await import("../lib/webhook-signing.js"),
		url: await import("../lib/webhook-url.js"),
		events: await import("../lib/webhook-events.js"),
		webhooks: await import("../lib/webhooks.js"),
		plans: await import("../lib/plans.js"),
		contacts: await import("../lib/contacts.js"),
		unsubscribe: await import("../lib/unsubscribe.js"),
		unsubscribeRoute: await import("../app/api/unsubscribe/route.js"),
		jobRoute: await import("../app/api/jobs/deliver-webhook/route.js"),
		sendBatchRoute: await import("../app/api/jobs/send-batch/route.js"),
		Account: (await import("../models/Account.js")).default,
		Contact: (await import("../models/Contact.js")).default,
		WebhookDelivery: (await import("../models/WebhookDelivery.js")).default,
		WebhookEndpoint: (await import("../models/WebhookEndpoint.js")).default,
		dashboard: await import("../app/(app)/webhooks/actions.js"),
		listPage: (await import("../app/(app)/webhooks/page.js")).default,
		endpointPage: (await import("../app/(app)/webhooks/[id]/page.js")).default,
		TooltipProvider: (await import("../components/ui/tooltip.jsx")).TooltipProvider,
	};
});

after(() => app?.stop());

beforeEach(() => {
	fake = installFakeStripe();
	newJobs();
});

describe("signatures", () => {
	test("match the Standard Webhooks specification's example", async () => {
		const header = await m.signing.signWebhook({
			secrets: ["whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"],
			id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
			timestamp: "1614265330",
			body: '{"test": 2432232314}',
		});
		assert.equal(header, "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
	});

	test("verify with an independent implementation, one signature per secret while a rotation lasts", async () => {
		const secret = m.signing.generateWebhookSecret();
		const previous = m.signing.generateWebhookSecret();
		assert.match(secret, /^whsec_[A-Za-z0-9+/]{43}=$/);
		assert.notEqual(secret, previous);
		const body = JSON.stringify({ type: "subscriber.created", data: { email: "jane@example.com" } });
		const headers = await m.signing.getWebhookHeaders({ secrets: [secret, previous], id: "msg_1", body, now: 1_760_000_000_123 });
		assert.equal(headers["webhook-timestamp"], "1760000000");
		assert.equal(headers["webhook-signature"].split(" ").length, 2);
		assert.ok(referenceVerify(secret, headers, body));
		assert.ok(referenceVerify(previous, headers, body));
		assert.ok(!referenceVerify(m.signing.generateWebhookSecret(), headers, body));
		assert.ok(!referenceVerify(secret, headers, `${body} `), "a changed body fails");
	});
});

describe("the address check", () => {
	test("takes public https addresses on the default port", () => {
		for (const url of ["https://hooks.zapier.com/hooks/standard/1/abc/", "https://hook.eu1.make.com/xyz", "https://8.8.8.8/in", "https://[2606:4700::1111]/x", "https://example.com:443/x"]) {
			assert.equal(m.url.getWebhookUrlProblem(url), null, url);
		}
	});

	test("refuses http, other ports, credentials and anything inside a network", () => {
		const refused = [
			"http://example.com/hook",
			"ftp://example.com",
			"https://example.com:8080/hook",
			"https://user:pass@example.com/hook",
			"https://localhost/hook",
			"https://api.localhost/hook",
			"https://intranet/hook",
			"https://printer.local/x",
			"https://metadata.google.internal/computeMetadata/v1/",
			"https://127.0.0.1/x",
			"https://2130706433/x",
			"https://0x7f.1/x",
			"https://10.1.2.3/x",
			"https://172.20.0.1/x",
			"https://192.168.1.1/x",
			"https://169.254.169.254/latest/meta-data/",
			"https://100.100.100.200/x",
			"https://0.0.0.0/x",
			"https://[::1]/x",
			"https://[::ffff:127.0.0.1]/x",
			"https://[::ffff:a9fe:a9fe]/x",
			"https://[fd00:ec2::254]/x",
			"https://[fe80::1]/x",
			"not a url",
			"",
		];
		for (const url of refused) assert.ok(m.url.getWebhookUrlProblem(url), url);
	});
});

describe("endpoints", () => {
	test("each plan allows its own number, and one more answers conflict", async () => {
		assert.deepEqual(
			m.plans.PLANS.map(({ id, webhookEndpoints }) => [id, webhookEndpoints]),
			[["starter", 3], ["growth", 5], ["pro", 10], ["scale", 20], ["max", 50]]
		);
		await withEnv({ FLOCKSTACK_CLOUD: "" }, () => assert.equal(m.plans.getWebhookEndpointLimit({ plan: "starter" }), null, "self-hosted: no limit"));

		const user = await seller();
		for (let index = 0; index < 3; index++) await addEndpoint(user, { description: `Hook ${index}` });
		const message = assertError(await api(user, "POST", "/webhooks", { url: RECEIVER }), 409, "conflict");
		assert.match(message, /up to 3 webhook endpoints/);
		assert.equal((await api(user, "GET", "/webhooks")).body.limit, 3);

		await activate(user, { plan: "growth" });
		assert.equal((await api(user, "POST", "/webhooks", { url: RECEIVER })).status, 201, "a bigger plan has room");
	});

	test("are created with a secret shown once, checked, updated, rotated and deleted with their log", async () => {
		const user = await seller();
		assertError(await api(user, "POST", "/webhooks", { url: "http://hooks.example.com/x" }), 400, "validation_failed");
		assertError(await api(user, "POST", "/webhooks", { url: "https://10.0.0.1/x" }), 400, "validation_failed");
		assertError(await api(user, "POST", "/webhooks", { url: RECEIVER, events: ["subscriber.exploded"] }), 400, "validation_failed");

		const { endpoint, secret } = await addEndpoint(user, { events: ["subscriber.unsubscribed", "subscriber.created"], newsletter: user.slug, source: "zapier" });
		assert.match(secret, /^whsec_/);
		assert.deepEqual(endpoint.events, ["subscriber.created", "subscriber.unsubscribed"], "each once, in the catalog's order");
		assert.equal(endpoint.newsletterId, user.newsletterId);
		assert.equal(endpoint.source, "zapier");
		const fetched = await api(user, "GET", `/webhooks/${endpoint.id}`);
		assert.equal(JSON.stringify(fetched.body).includes(secret), false, "the secret isn't shown again");

		const changed = await api(user, "PATCH", `/webhooks/${endpoint.id}`, { events: [], newsletter: null, description: "Everything" });
		assert.deepEqual([changed.body.events, changed.body.newsletterId, changed.body.description], [[], null, "Everything"]);

		const rotated = await api(user, "POST", `/webhooks/${endpoint.id}/rotate-secret`);
		assert.notEqual(rotated.body.secret, secret);
		const stored = await m.WebhookEndpoint.findOne({ accountId: user.accountId, _id: endpoint.id }).lean();
		assert.deepEqual(m.webhooks.getSigningSecrets(stored), [rotated.body.secret, secret], "both sign for a day");
		assert.deepEqual(m.webhooks.getSigningSecrets(stored, Date.now() + 2 * DAY_MS), [rotated.body.secret]);

		await api(user, "POST", `/webhooks/${endpoint.id}/test`);
		assert.equal(await m.WebhookDelivery.countDocuments({ accountId: user.accountId, endpointId: endpoint.id }), 1);
		assert.equal((await api(user, "DELETE", `/webhooks/${endpoint.id}`)).status, 200);
		assert.equal(await m.WebhookDelivery.countDocuments({ accountId: user.accountId, endpointId: endpoint.id }), 0);
		assertError(await api(user, "GET", `/webhooks/${endpoint.id}`), 404, "not_found");
	});

	test("belong to their account", async () => {
		const alice = await seller();
		const bob = await seller();
		const { endpoint } = await addEndpoint(alice);
		assertError(await api(bob, "GET", `/webhooks/${endpoint.id}`), 404, "not_found");
		assertError(await api(bob, "DELETE", `/webhooks/${endpoint.id}`), 404, "not_found");
		assert.equal((await api(bob, "GET", "/webhooks")).body.endpoints.length, 0);
	});
});

describe("events", () => {
	test("subscriber.created, updated, confirmed and unsubscribed come from signups, tags, fields, confirmations and unsubscribes", async () => {
		const user = await seller({ requireConfirmation: true });
		await addEndpoint(user);
		const { requests, fetchImpl } = receiver();

		const added = await api(user, "POST", "/contacts", { email: "jane@example.com", tags: ["podcast"] });
		assert.equal(added.status, 201);
		await flushAfter();
		await api(user, "POST", `/contacts/${added.body.id}/tags`, { tag: "vip" });
		await api(user, "POST", `/contacts/${added.body.id}/tags`, { tag: "vip" });
		await api(user, "POST", "/contacts", { email: "jane@example.com", tags: ["podcast", "launch"] });
		await flushAfter();
		await m.contacts.confirmContact({ accountId: user.accountId, contactId: added.body.id, newsletterId: user.newsletterId });
		await api(user, "PATCH", `/contacts/${added.body.id}`, { status: "unsubscribed" });
		await runDeliveries(fetchImpl);

		const bodies = bodiesOf(requests);
		assert.deepEqual(
			bodies.map(({ type }) => type),
			["subscriber.created", "subscriber.updated", "subscriber.updated", "subscriber.confirmed", "subscriber.unsubscribed"],
			"adding a tag it has changes nothing"
		);
		const [created, tagged, again, confirmed, unsubscribed] = bodies;
		assert.deepEqual([created.data.subscriber.email, created.data.subscriber.status, created.data.subscriber.tags, created.data.resubscribed], ["jane@example.com", "pending", ["podcast"], false]);
		assert.deepEqual(tagged.data.changes, { tagsAdded: ["vip"], tagsRemoved: [], fields: [] });
		assert.deepEqual(again.data.changes.tagsAdded, ["launch"]);
		assert.equal(confirmed.data.subscriber.status, "active");
		assert.ok(confirmed.data.subscriber.confirmedAt);
		assert.deepEqual([unsubscribed.data.subscriber.status, Boolean(unsubscribed.data.subscriber.unsubscribedAt)], ["unsubscribed", true]);
		for (const body of bodies) {
			assert.deepEqual(Object.keys(body), ["type", "timestamp", "data"]);
			assert.ok(!Number.isNaN(Date.parse(body.timestamp)));
		}
		assert.equal(new Set(requests.map(({ headers }) => headers["webhook-id"])).size, requests.length, "each event its own id");
	});

	test("the unsubscribe link sends subscriber.unsubscribed, and an endpoint gets only the events and newsletter it asked for", async () => {
		const user = await seller();
		await addEndpoint(user, { events: ["subscriber.unsubscribed"] });
		const contact = await m.Contact.create({ accountId: user.accountId, newsletterId: user.newsletterId, email: "leaving@example.com", status: "active" });
		const token = m.unsubscribe.createUnsubscribeToken({ contactId: contact._id, newsletterId: user.newsletterId });
		const response = await anonymous(() => m.unsubscribeRoute.POST(new Request(`http://localhost:3000/api/unsubscribe?token=${token}`, { method: "POST" })));
		assert.equal(response.status, 200);
		await api(user, "POST", "/contacts", { email: "new@example.com" });
		await flushAfter();
		const { requests, fetchImpl } = receiver();
		await runDeliveries(fetchImpl);
		assert.deepEqual(bodiesOf(requests).map(({ type, data }) => [type, data.subscriber.email]), [["subscriber.unsubscribed", "leaving@example.com"]]);

		const other = await m.Contact.create({ accountId: user.accountId, newsletterId: user.newsletterId, email: "x@example.com", status: "active" });
		const elsewhere = { accountId: user.accountId, newsletterId: "6650f1c2e9b1d4a0123456aa", type: "subscriber.unsubscribed", data: { subscriber: { id: String(other._id) } } };
		await m.WebhookEndpoint.updateMany({ accountId: user.accountId }, { $set: { newsletterId: user.newsletterId } });
		assert.equal(await m.webhooks.emitWebhookEvent(elsewhere), 0, "another newsletter's event");
		assert.equal(await m.webhooks.emitWebhookEvent({ ...elsewhere, newsletterId: user.newsletterId }), 1);
	});

	test("nothing goes out for an account without endpoints, or without a plan", async () => {
		const user = await seller();
		assert.equal(await m.webhooks.emitWebhookEvent({ accountId: user.accountId, type: "subscriber.created", data: () => assert.fail("not loaded") }), 0);
		await addEndpoint(user);
		await m.Account.updateOne({ _id: user.accountId }, { $set: { subscriptionStatus: "canceled" } });
		assert.equal(await m.webhooks.emitWebhookEvent({ accountId: user.accountId, type: "subscriber.created", data: {} }), 0);
	});

	test("campaign.sent comes when a campaign finishes going out", async () => {
		const user = await seller();
		await addEndpoint(user, { events: ["campaign.sent"] });
		await m.Contact.create({ accountId: user.accountId, newsletterId: user.newsletterId, email: "reader@example.com", status: "active" });
		const created = await api(user, "POST", "/campaigns", { subject: "Issue 12", previewText: "This week", content: "Hello readers." });
		assert.equal((await api(user, "POST", `/campaigns/${created.body.id}/send`)).status, 200);
		for (const { url, body } of published.slice(processed)) {
			if (url.endsWith("/api/jobs/send-batch")) await m.sendBatchRoute.POST(jsonRequest(url, { method: "POST", body }));
		}
		const { requests, fetchImpl } = receiver();
		await runDeliveries(fetchImpl);
		const [event] = bodiesOf(requests);
		assert.equal(requests.length, 1);
		assert.equal(event.type, "campaign.sent");
		assert.deepEqual([event.data.campaign.id, event.data.campaign.subject, event.data.campaign.stats.recipients], [created.body.id, "Issue 12", 1]);
		assert.match(event.data.campaign.archiveUrl ?? "", /^https:\/\//);
	});

	test("order.paid comes once per order, and upgraded and downgraded follow a reader's paid subscription", async () => {
		const user = await seller();
		await addEndpoint(user, { events: ["order.paid", "subscriber.upgraded", "subscriber.downgraded"] });
		const product = await createProduct(user);
		const { url } = await buy(user, product.slug, { email: "sam@example.com" });
		const { event } = await payForSession(fake, user, url, { email: "sam@example.com", name: "Sam" });
		await postPaymentEvent(event);

		const tier = await api(user, "PATCH", `/newsletters/${user.slug}/paid-tier`, { enabled: true, monthlyCents: 800, yearlyCents: 8000 });
		assert.equal(tier.status, 200, JSON.stringify(tier.body));
		const reader = await m.Contact.create({ accountId: user.accountId, newsletterId: user.newsletterId, email: "paid@example.com", status: "active" });
		const customer = fake.addCustomer({ email: "paid@example.com" });
		const metadata = { flockstack: "1", kind: "paid_tier", accountId: String(user.accountId), newsletterId: user.newsletterId };
		const subscription = fake.addSubscription({ customer: customer.id, status: "active", metadata, items: { data: [{ id: "si_1", price: { recurring: { interval: "year" } } }] } });
		await m.Contact.updateOne({ accountId: user.accountId, _id: reader._id }, { $set: { stripeCustomerId: customer.id } });
		const send = (type, object) => postPaymentEvent(fake.event(type, object, { account: user.stripeAccountId }));
		await send("customer.subscription.created", { id: subscription.id, object: "subscription" });
		await send("customer.subscription.updated", { id: subscription.id, object: "subscription" });
		fake.subscriptions.set(subscription.id, { ...fake.subscriptions.get(subscription.id), status: "canceled" });
		await send("customer.subscription.deleted", { id: subscription.id, object: "subscription" });

		const { requests, fetchImpl } = receiver();
		await runDeliveries(fetchImpl);
		const bodies = bodiesOf(requests);
		assert.deepEqual(bodies.map(({ type }) => type), ["order.paid", "subscriber.upgraded", "subscriber.downgraded"], "a repeated event sends nothing again");
		const [order, upgraded, downgraded] = bodies;
		assert.deepEqual([order.data.order.buyerEmail, order.data.order.productTitle, order.data.order.amountCents], ["sam@example.com", product.title, 1900]);
		assert.deepEqual([upgraded.data.subscriber.email, upgraded.data.subscriber.tier, upgraded.data.interval], ["paid@example.com", "paid", "year"]);
		assert.deepEqual([downgraded.data.subscriber.tier, downgraded.data.subscriptionStatus], ["free", "canceled"]);
	});
});

describe("delivery", () => {
	test("is signed, posted without following redirects, and logged", async () => {
		const user = await seller();
		const { endpoint, secret } = await addEndpoint(user);
		await api(user, "POST", "/contacts", { email: "signed@example.com" });
		await flushAfter();
		const { requests, fetchImpl } = receiver([204]);
		await runDeliveries(fetchImpl);
		const [request] = requests;
		assert.equal(request.url, RECEIVER);
		assert.equal(request.redirect, "manual");
		assert.equal(request.headers["content-type"], "application/json");
		assert.match(request.headers["webhook-id"], /^msg_[0-9a-f]{24}$/);
		assert.ok(referenceVerify(secret, request.headers, request.body));

		const [delivery] = (await api(user, "GET", `/webhooks/${endpoint.id}/deliveries`)).body.deliveries;
		assert.deepEqual([delivery.status, delivery.attempts, delivery.responseStatus, delivery.type, delivery.messageId], ["delivered", 1, 204, "subscriber.created", request.headers["webhook-id"]]);
		assert.equal(delivery.payload, request.body);
	});

	test("runs through the QStash job route", async () => {
		const user = await seller();
		await addEndpoint(user);
		await api(user, "POST", "/contacts", { email: "routed@example.com" });
		await flushAfter();
		const [job] = newJobs();
		const original = globalThis.fetch;
		const seen = [];
		globalThis.fetch = async (url, init) => (String(url) === RECEIVER ? (seen.push(init), new Response("ok")) : original(url, init));
		try {
			const response = await m.jobRoute.POST(jsonRequest(job.url, { method: "POST", body: job.body }));
			assert.deepEqual(await response.json(), { delivered: true, status: 200 });
			const again = await m.jobRoute.POST(jsonRequest(job.url, { method: "POST", body: job.body }));
			assert.match((await again.json()).ignored, /attempted already/, "QStash delivering the job twice posts once");
		} finally {
			globalThis.fetch = original;
		}
		assert.equal(seen.length, 1);
	});

	test("retries with growing delays, keeps the same id, and gives up after about 5 days", async () => {
		const user = await seller();
		const { endpoint } = await addEndpoint(user);
		await api(user, "POST", "/contacts", { email: "down@example.com" });
		await flushAfter();
		const start = Date.now();
		const { requests, fetchImpl } = receiver(Array(m.webhooks.MAX_ATTEMPTS).fill(503));

		// Only the attempts: the endpoint's failures start over each time, so it isn't turned off, which the next test covers.
		const delays = [];
		let now = start;
		for (let attempt = 1; ; attempt++) {
			const [job] = newJobs();
			if (!job) break;
			if (job.notBefore) delays.push(job.notBefore - Math.floor(now / 1000));
			now = job.notBefore ? job.notBefore * 1000 : now;
			await m.webhooks.deliverWebhook(job.body, { fetchImpl, now });
			await m.WebhookEndpoint.updateOne({ accountId: user.accountId, _id: endpoint.id }, { $unset: { failingSince: 1 } });
		}
		assert.equal(requests.length, m.webhooks.MAX_ATTEMPTS);
		assert.deepEqual(delays, m.webhooks.RETRY_DELAYS_SECONDS);
		for (let index = 1; index < delays.length; index++) assert.ok(delays[index] >= delays[index - 1]);
		const total = m.webhooks.RETRY_DELAYS_SECONDS.reduce((sum, seconds) => sum + seconds, 0);
		assert.ok(total > 4.5 * 86_400 && total < 5 * 86_400, `${total} seconds`);
		assert.equal(new Set(requests.map(({ headers }) => headers["webhook-id"])).size, 1);
		assert.equal(new Set(requests.map(({ headers }) => headers["webhook-timestamp"])).size, requests.length, "each attempt signed at its own time");

		const [delivery] = (await api(user, "GET", `/webhooks/${endpoint.id}/deliveries`)).body.deliveries;
		assert.deepEqual([delivery.status, delivery.attempts, delivery.responseStatus, delivery.error, delivery.nextAttemptAt], ["failed", m.webhooks.MAX_ATTEMPTS, 503, "Answered 503", null]);
	});

	test("an endpoint failing for 5 days is turned off and its owner emailed; turning it on and resending works", async () => {
		const user = await seller();
		const { endpoint } = await addEndpoint(user);
		await api(user, "POST", "/contacts", { email: "a@example.com" });
		await flushAfter();
		const failing = receiver(Array(20).fill(new Error("connect ECONNREFUSED")));
		const results = await runDeliveries(failing.fetchImpl);
		assert.ok(results.at(-1).disabled, JSON.stringify(results.at(-1)));
		const off = (await api(user, "GET", `/webhooks/${endpoint.id}`)).body;
		assert.deepEqual([off.enabled, off.disabledReason], [false, "it hasn't accepted an event in about 5 days of retries"]);
		const alert = platformEmails.findLast(({ subject }) => subject.includes("webhook endpoint was turned off"));
		assert.ok(alert, "the owner is emailed");
		assert.deepEqual(alert.to, [user.email]);
		assert.match(alert.text, /hooks\.example\.com/);

		await api(user, "POST", "/contacts", { email: "b@example.com" });
		await flushAfter();
		assert.equal(newJobs().length, 0, "nothing goes to an endpoint that is off");
		assertError(await api(user, "POST", `/webhooks/${endpoint.id}/deliveries/${(await m.WebhookDelivery.findOne({ accountId: user.accountId }).lean())._id}/resend`), 409, "conflict");

		const on = (await api(user, "PATCH", `/webhooks/${endpoint.id}`, { enabled: true })).body;
		assert.deepEqual([on.enabled, on.disabledReason, on.failingSince], [true, null, null]);
		const [failed] = (await api(user, "GET", `/webhooks/${endpoint.id}/deliveries`, undefined)).body.deliveries;
		const resent = await api(user, "POST", `/webhooks/${endpoint.id}/deliveries/${failed.id}/resend`);
		assert.equal(resent.body.delivery.messageId, failed.messageId);
		const working = receiver();
		await runDeliveries(working.fetchImpl);
		assert.equal(working.requests[0].headers["webhook-id"], failed.messageId);
		assert.equal((await api(user, "GET", `/webhooks/${endpoint.id}`)).body.lastSuccessAt !== null, true);
	});

	test("410 Gone turns the endpoint off at once, a redirect counts as a failure, and a test event is tried once", async () => {
		const user = await seller();
		const { endpoint } = await addEndpoint(user);
		await api(user, "POST", `/webhooks/${endpoint.id}/test`);
		const redirect = receiver([301]);
		await runDeliveries(redirect.fetchImpl);
		assert.equal(redirect.requests.length, 1, "a test event isn't retried");
		assert.equal(JSON.parse(redirect.requests[0].body).type, "webhook.test");
		const [test] = (await api(user, "GET", `/webhooks/${endpoint.id}/deliveries`)).body.deliveries;
		assert.deepEqual([test.status, test.test], ["failed", true]);
		assert.match(test.error, /redirects aren't followed/);
		assert.equal((await api(user, "GET", `/webhooks/${endpoint.id}`)).body.failingSince, null, "tests don't count toward turning it off");

		await api(user, "POST", "/contacts", { email: "gone@example.com" });
		await flushAfter();
		await runDeliveries(receiver([410]).fetchImpl);
		const gone = (await api(user, "GET", `/webhooks/${endpoint.id}`)).body;
		assert.equal(gone.enabled, false);
		assert.match(gone.disabledReason, /410 Gone/);
	});

	test("keeps only the latest deliveries of each endpoint", async () => {
		const user = await seller();
		const { endpoint } = await addEndpoint(user);
		const stored = await m.WebhookEndpoint.findOne({ accountId: user.accountId, _id: endpoint.id }).lean();
		const limit = m.webhooks.MAX_DELIVERIES_PER_ENDPOINT;
		const old = new Date(Date.now() - DAY_MS);
		await m.WebhookDelivery.insertMany(
			Array.from({ length: limit }, (_, index) => ({
				accountId: user.accountId,
				endpointId: stored._id,
				messageId: `msg_old${index}`,
				type: "subscriber.created",
				payload: "{}",
				status: "delivered",
				createdAt: new Date(old.getTime() + index),
			}))
		);
		await api(user, "POST", `/webhooks/${endpoint.id}/test`);
		assert.equal(await m.WebhookDelivery.countDocuments({ accountId: user.accountId, endpointId: stored._id }), limit);
		assert.equal(await m.WebhookDelivery.countDocuments({ accountId: user.accountId, messageId: "msg_old0" }), 0, "the oldest went");
		assert.equal((await api(user, "GET", `/webhooks/${endpoint.id}/deliveries`, undefined)).body.deliveries[0].test, true);
	});

	test("an address that became unsafe isn't called", async () => {
		const user = await seller();
		const { endpoint } = await addEndpoint(user);
		await m.WebhookEndpoint.updateOne({ accountId: user.accountId, _id: endpoint.id }, { $set: { url: "https://169.254.169.254/latest" } });
		await api(user, "POST", `/webhooks/${endpoint.id}/test`);
		const { requests, fetchImpl } = receiver();
		await runDeliveries(fetchImpl);
		assert.equal(requests.length, 0);
	});
});

describe("the dashboard", () => {
	const textOf = (markup) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ");

	async function render(user, page, props = {}) {
		const element = await as(user, () => page(props));
		return textOf(renderToStaticMarkup(createElement(m.TooltipProvider, null, element)));
	}

	test("creates an endpoint from the form, lists it, and edits, tests and deletes it on its page", async () => {
		const user = await seller();
		assert.match(await render(user, m.listPage), /No webhooks yet.*0 of 3 endpoints/);

		const refused = await as(user, () => m.dashboard.createWebhookEndpoint(null, form({ url: "http://example.com/x", allEvents: "on" })));
		assert.match(refused.error, /https/);
		const data = form({ url: RECEIVER, description: "CRM sync", newsletter: "all" });
		data.append("events", "subscriber.created");
		data.append("events", "order.paid");
		const created = await as(user, () => m.dashboard.createWebhookEndpoint(null, data));
		assert.match(created.secret, /^whsec_/);
		const stored = await m.WebhookEndpoint.findOne({ accountId: user.accountId, _id: created.id }).lean();
		assert.deepEqual([stored.events, stored.source, stored.newsletterId ?? null], [["subscriber.created", "order.paid"], "dashboard", null]);

		const list = await render(user, m.listPage);
		assert.match(list, /hooks\.example\.com\/flockstack/);
		assert.match(list, /CRM sync · 2 events · Nothing sent yet/);

		const saved = await as(user, () => m.dashboard.updateWebhookEndpoint(created.id, { url: RECEIVER, description: "CRM", events: [], newsletterId: null, enabled: false }));
		assert.deepEqual([saved.endpoint.enabled, saved.endpoint.events], [false, []]);
		assert.deepEqual(await as(user, () => m.dashboard.sendTestWebhook(created.id)), { ok: true });
		const page = await render(user, m.endpointPage, { params: Promise.resolve({ id: created.id }) });
		assert.match(page, /Signing secret/);
		assert.match(page, /webhook\.test/);
		assert.doesNotMatch(page, new RegExp(created.secret.slice(6, 20).replace(/[+/]/g, "\\$&")), "the secret isn't on the page");
		const rotated = await as(user, () => m.dashboard.rotateWebhookSecret(created.id));
		assert.match(rotated.secret, /^whsec_/);
		assert.deepEqual(await as(user, () => m.dashboard.deleteWebhookEndpoint(created.id)), { ok: true });
	});
});
