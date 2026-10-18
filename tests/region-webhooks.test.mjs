import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";
import Stripe from "stripe";
import mongoose from "@/lib/docdb";
import { buildSigningString } from "../lib/sns.js";
import { jsonRequest, mockPolar, mockStripe, platformEmails, signIn, startTestApp, telegramMessages } from "./helpers/app.mjs";

// The same Polar, Stripe or SES configuration can deliver to the US Worker and the EU Worker, so each gets events for
// accounts that live in the other region. This process is the EU Worker. Those events are acknowledged with a 2xx and an
// info line, never an alert and never a retry; a bad signature or a real failure is still refused.
const POLAR_SECRET = "polar_whs_region_secret";
const PAYMENTS_SECRET = "whsec_region_payments_secret";
const POSTSHIBA_SECRET = "ps-region-webhook-secret";
const SES_TOPIC = "arn:aws:sns:eu-west-1:111122223333:flockstack-eu-ses-events";
const TENANT_TOPIC = "arn:aws:sns:eu-west-1:111122223333:flockstack-eu-ses-tenants";
const CERT_URL = "https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-0123456789abcdef0123456789abcdef.pem";
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });

// What the other region's database would hold: ids this one has never seen.
const OTHER_ACCOUNT = String(new mongoose.Types.ObjectId());
const OTHER_MESSAGE = String(new mongoose.Types.ObjectId());

let app;
let m;
let polarSubscriptions;
let stripeSubscriptions;
let eventCount = 0;

// Runs with the console recorded, and says what was logged and whether anyone was alerted.
async function observe(run) {
	const logs = { info: [], warn: [], error: [] };
	const saved = { info: console.info, warn: console.warn, error: console.error };
	for (const level of Object.keys(logs)) console[level] = (...args) => logs[level].push(args.join(" "));
	const emails = platformEmails.length;
	const telegram = telegramMessages.length;
	let result;
	try {
		result = await run();
	} finally {
		Object.assign(console, saved);
	}
	return { result, logs, alerts: platformEmails.length - emails + telegramMessages.length - telegram };
}

function assertAcknowledged({ logs, alerts }, label) {
	assert.equal(alerts, 0, "no alert");
	assert.deepEqual(logs.error, [], "no error line");
	assert.deepEqual(logs.warn, [], "no warning");
	assert.equal(logs.info.filter((line) => line.startsWith(`[${label}]`) && /no such account in this region \(eu\), acknowledged/.test(line)).length, 1, logs.info.join("\n"));
}

const iso = (seconds) => new Date(seconds * 1000).toISOString();

function polarSubscription(id, { accountId = OTHER_ACCOUNT, customer = "cus_other_region" } = {}) {
	return {
		id,
		status: "active",
		customer_id: customer,
		product_id: "prod_starter_month",
		product: { id: "prod_starter_month", metadata: { flockstack_plan: "starter", interval: "month" } },
		recurring_interval: "month",
		current_period_start: iso(NOW),
		current_period_end: iso(NOW + 30 * DAY),
		cancel_at_period_end: false,
		metadata: { accountId },
		customer: { id: customer, external_id: accountId },
	};
}

async function deliverPolar(type, data, { secret = POLAR_SECRET } = {}) {
	const timestamp = Math.floor(Date.now() / 1000);
	const body = JSON.stringify({ type, timestamp: iso(timestamp), data });
	const id = `msg_${++eventCount}`;
	const signature = await m.signPolar({ secret, id, timestamp, body });
	const response = await m.polarRoute.POST(
		new Request("http://localhost:3000/api/webhooks/polar", {
			method: "POST",
			headers: { "webhook-id": id, "webhook-timestamp": String(timestamp), "webhook-signature": signature },
			body,
		})
	);
	return { status: response.status, body: await response.json() };
}

async function deliverStripe(type, object, { secret = process.env.STRIPE_WEBHOOK_SECRET } = {}) {
	const payload = JSON.stringify({ id: `evt_region_${++eventCount}`, object: "event", type, created: NOW, data: { object } });
	const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret });
	const response = await m.stripeRoute.POST(new Request("http://localhost:3000/api/webhooks/stripe", { method: "POST", headers: { "stripe-signature": signature }, body: payload }));
	return { status: response.status, body: await response.json() };
}

async function deliverPayments(event, { secret = PAYMENTS_SECRET } = {}) {
	const body = JSON.stringify(event);
	const signature = await m.signStripe({ secret, body, timestamp: NOW });
	const response = await m.paymentsRoute.POST(new Request("http://localhost:3000/api/webhooks/payments", { method: "POST", headers: { "stripe-signature": signature }, body }));
	return { status: response.status, body: await response.json() };
}

function signSns(message) {
	const unsigned = { SigningCertURL: CERT_URL, SignatureVersion: "2", ...message };
	return { ...unsigned, Signature: crypto.createSign("RSA-SHA256").update(buildSigningString(unsigned)).sign(privateKey, "base64") };
}

function notification(topic, event) {
	return signSns({ Type: "Notification", MessageId: crypto.randomUUID(), TopicArn: topic, Message: JSON.stringify(event), Timestamp: new Date().toISOString() });
}

const post = (route, path, body) => route.POST(jsonRequest(path, { method: "POST", body }));

function polarApi({ method, path }) {
	if (method === "GET" && path.startsWith("/v1/subscriptions/")) return polarSubscriptions.get(path.split("/").at(-1)) ?? { status: 404, error: "Subscription not found" };
	return { status: 404, error: `No mock for ${method} ${path}` };
}

function stripeApi({ method, path }) {
	if (method === "GET" && path.startsWith("/v1/subscriptions/")) {
		return stripeSubscriptions.get(path.split("/").at(-1)) ?? { status: 404, error: { type: "invalid_request_error", message: "No such subscription" } };
	}
	return { status: 404, error: { type: "invalid_request_error", message: `No mock for ${method} ${path}` } };
}

before(async () => {
	app = await startTestApp({
		FLOCKSTACK_REGION: "eu",
		POLAR_ACCESS_TOKEN: "polar_oat_test",
		POLAR_WEBHOOK_SECRET: POLAR_SECRET,
		STRIPE_PAYMENTS_WEBHOOK_SECRET: PAYMENTS_SECRET,
		POSTSHIBA_WEBHOOK_SECRET: POSTSHIBA_SECRET,
		SES_SNS_TOPIC_ARN: SES_TOPIC,
		SES_TENANT_SNS_TOPIC_ARN: TENANT_TOPIC,
	});
	const polar = await import("../lib/polar-webhook.js");
	m = {
		signPolar: (options) => polar.signPolarWebhook(options),
		signStripe: (await import("../lib/payments/signature.js")).signStripePayload,
		polarRoute: await import("../app/api/webhooks/polar/route.js"),
		stripeRoute: await import("../app/api/webhooks/stripe/route.js"),
		paymentsRoute: await import("../app/api/webhooks/payments/route.js"),
		sesRoute: await import("../app/api/webhooks/ses/route.js"),
		tenantRoute: await import("../app/api/webhooks/ses-tenants/route.js"),
		postshibaRoute: await import("../app/api/webhooks/postshiba/route.js"),
		Account: (await import("../models/Account.js")).default,
		Suppression: (await import("../models/Suppression.js")).default,
	};
	const fetchCertificate = globalThis.fetch;
	globalThis.fetch = async (input, init) => (String(input) === CERT_URL ? new Response(publicKey.export({ type: "spki", format: "pem" })) : fetchCertificate(input, init));
	// A signed-in admin, so that an alert has somewhere to go: the control tests show it would have been sent.
	await signIn("admin@example.com");
});

beforeEach(() => {
	polarSubscriptions = new Map();
	stripeSubscriptions = new Map();
	mockPolar(polarApi);
	mockStripe(stripeApi);
});

after(() => app?.stop());

describe("Polar", () => {
	test("a subscription of an account in the other region is acknowledged, logged at info level, and changes nothing", async () => {
		polarSubscriptions.set("sub_other", polarSubscription("sub_other"));
		const observed = await observe(() => deliverPolar("subscription.created", { id: "sub_other" }));
		assert.deepEqual([observed.result.status, observed.result.body.ignored], [200, "no account"]);
		assertAcknowledged(observed, "polar-webhook");
		assert.match(observed.logs.info[0], /subscription sub_other/);
		assert.equal(await m.Account.countDocuments({ polarSubscriptionId: "sub_other" }), 0);
	});

	test("so is a paid order of one, and a subscription of a customer this region has never seen", async () => {
		polarSubscriptions.set("sub_order", polarSubscription("sub_order", { customer: "cus_order_other" }));
		const order = await observe(() => deliverPolar("order.paid", { id: "ord_other", subscription_id: "sub_order", billing_reason: "subscription_cycle" }));
		assert.deepEqual([order.result.status, order.result.body.ignored], [200, "no account"]);
		assertAcknowledged(order, "polar-webhook");
		assert.match(order.logs.info[0], /order ord_other of subscription sub_order/);

		polarSubscriptions.set("sub_nobody", polarSubscription("sub_nobody", { accountId: null, customer: "cus_nobody" }));
		const nobody = await observe(() => deliverPolar("subscription.updated", { id: "sub_nobody" }));
		assert.equal(nobody.result.status, 200);
		assertAcknowledged(nobody, "polar-webhook");
	});

	test("events of other kinds keep being ignored without a line", async () => {
		const observed = await observe(() => deliverPolar("customer.created", { id: "cus_x" }));
		assert.deepEqual([observed.result.status, observed.result.body.ignored], [200, "customer.created"]);
		assert.deepEqual(observed.logs, { info: [], warn: [], error: [] });
	});

	test("the signature stays strict, and a real failure still retries and alerts", async () => {
		polarSubscriptions.set("sub_other", polarSubscription("sub_other"));
		assert.equal((await observe(() => deliverPolar("subscription.created", { id: "sub_other" }, { secret: "someone_elses_secret" }))).result.status, 403);
		assert.equal((await observe(() => m.polarRoute.POST(new Request("http://localhost:3000/api/webhooks/polar", { method: "POST", body: "{}" })))).result.status, 403);

		const failed = await observe(() => deliverPolar("subscription.updated", { id: "sub_not_in_polar" }));
		assert.equal(failed.result.status, 500);
		assert.equal(failed.alerts, 1);
	});
});

describe("Stripe plan billing", () => {
	test("a subscription, its invoice and its checkout, all of an account in the other region, are acknowledged and logged at info level", async () => {
		stripeSubscriptions.set("sub_other", {
			id: "sub_other",
			object: "subscription",
			status: "active",
			customer: "cus_other_region",
			metadata: { accountId: OTHER_ACCOUNT },
			items: { data: [{ price: { lookup_key: "starter_month" }, current_period_start: NOW, current_period_end: NOW + 30 * DAY }] },
		});
		const subscription = await observe(() => deliverStripe("customer.subscription.updated", { id: "sub_other" }));
		assert.deepEqual([subscription.result.status, subscription.result.body.ignored], [200, "no account"]);
		assertAcknowledged(subscription, "stripe-webhook");

		const invoice = await observe(() =>
			deliverStripe("invoice.paid", {
				id: "in_other",
				customer: "cus_other_region",
				parent: { type: "subscription_details", subscription_details: { subscription: "sub_other", metadata: { accountId: OTHER_ACCOUNT } } },
				lines: { data: [{ period: { start: NOW, end: NOW + 30 * DAY } }] },
			})
		);
		assert.deepEqual([invoice.result.status, invoice.result.body.ignored], [200, "no account"]);
		assertAcknowledged(invoice, "stripe-webhook");

		const checkout = await observe(() =>
			deliverStripe("checkout.session.completed", { id: "cs_other", mode: "subscription", subscription: "sub_other", customer: "cus_other_region", client_reference_id: OTHER_ACCOUNT })
		);
		assert.deepEqual([checkout.result.status, checkout.result.body.ignored], [200, "no account"]);
		assertAcknowledged(checkout, "stripe-webhook");
	});

	test("the signature stays strict", async () => {
		const forged = await observe(() => deliverStripe("customer.subscription.updated", { id: "sub_other" }, { secret: "whsec_someone_else" }));
		assert.equal(forged.result.status, 400);
		assert.equal(forged.alerts, 0);
	});
});

describe("Stripe Connect", () => {
	test("an event of a connected account that signed up in the other region is acknowledged and logged at info level", async () => {
		const event = { id: "evt_connect_other", object: "event", type: "checkout.session.completed", account: "acct_other_region", data: { object: { id: "cs_x", metadata: { flockstack: "1", accountId: OTHER_ACCOUNT, kind: "product" } } } };
		const observed = await observe(() => deliverPayments(event));
		assert.deepEqual([observed.result.status, observed.result.body.ignored], [200, "unknown account"]);
		assertAcknowledged(observed, "payments-webhook");
		assert.match(observed.logs.info[0], /checkout\.session\.completed evt_connect_other/);

		const update = await observe(() => deliverPayments({ id: "evt_connect_update", object: "event", type: "account.updated", data: { object: { id: "acct_other_region", charges_enabled: true } } }));
		assert.deepEqual([update.result.status, update.result.body.ignored], [200, "unknown account"]);
		assertAcknowledged(update, "payments-webhook");
	});

	test("the signature stays strict", async () => {
		const event = { id: "evt_connect_forged", object: "event", type: "account.updated", account: "acct_other_region", data: { object: { id: "acct_other_region" } } };
		const forged = await observe(() => deliverPayments(event, { secret: "whsec_someone_else" }));
		assert.equal(forged.result.status, 400);
		assert.equal(forged.alerts, 0);
	});
});

describe("Amazon SES through SNS", () => {
	function bounceFor(accountId) {
		return {
			eventType: "Bounce",
			mail: { messageId: `0100region-${accountId}`, destination: ["reader@example.com"], tags: { account_id: [accountId], message_id: [OTHER_MESSAGE] } },
			bounce: { bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: [{ emailAddress: "reader@example.com" }] },
		};
	}

	test("a bounce of a message sent from the other region is acknowledged, logged at info level, and suppresses nothing here", async () => {
		const observed = await observe(() => post(m.sesRoute, "/api/webhooks/ses", notification(SES_TOPIC, bounceFor(OTHER_ACCOUNT))));
		assert.equal(observed.result.status, 200);
		assert.deepEqual(await observed.result.json(), { ok: true });
		assertAcknowledged(observed, "email-events");
		assert.equal(await m.Suppression.countDocuments({ accountId: OTHER_ACCOUNT }), 0);
	});

	test("so is an event for a tenant of the other region", async () => {
		const event = {
			source: "aws.ses",
			"detail-type": "Sending Status Disabled",
			time: "2026-10-12T08:00:00Z",
			resources: [`arn:aws:ses:eu-west-1:111122223333:tenant/mc-${OTHER_ACCOUNT}/tn-0123`],
			detail: { data: { record: { status: "DISABLED", cause: "Bounce rate" } } },
		};
		const observed = await observe(() => post(m.tenantRoute, "/api/webhooks/ses-tenants", notification(TENANT_TOPIC, event)));
		assert.equal(observed.result.status, 200);
		assertAcknowledged(observed, "ses-tenants");
	});

	test("the signature and the topic stay strict", async () => {
		const forged = { ...notification(SES_TOPIC, bounceFor(OTHER_ACCOUNT)), Message: JSON.stringify(bounceFor(OTHER_ACCOUNT)).replace("Permanent", "Transient") };
		assert.equal((await observe(() => post(m.sesRoute, "/api/webhooks/ses", forged))).result.status, 400);
		const wrongTopic = await observe(() => post(m.sesRoute, "/api/webhooks/ses", notification(TENANT_TOPIC, bounceFor(OTHER_ACCOUNT))));
		assert.equal(wrongTopic.result.status, 403);
		assert.equal(wrongTopic.alerts, 0);
	});
});

describe("PostShiba", () => {
	function signedRequest(events, secret = POSTSHIBA_SECRET) {
		const body = JSON.stringify(events);
		const timestamp = String(Math.floor(Date.now() / 1000));
		const signature = `sha256=${crypto.createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex")}`;
		return new Request("http://localhost:3000/api/webhooks/postshiba", {
			method: "POST",
			headers: { "content-type": "application/json", "x-capsule-timestamp": timestamp, "x-capsule-signature": signature },
			body,
		});
	}

	test("a bounce of a tenant that lives in the other region is acknowledged and logged at info level", async () => {
		const args = { account_id: OTHER_ACCOUNT, message_id: OTHER_MESSAGE };
		const event = { event: "bounce", email: "reader@example.com", timestamp: NOW, sg_event_id: "capsule-region-1", sg_message_id: "abc@postshiba.test", tenant_id: `mc-${OTHER_ACCOUNT}`, ...args, unique_args: args };
		const observed = await observe(() => m.postshibaRoute.POST(signedRequest([event])));
		assert.equal(observed.result.status, 200);
		assertAcknowledged(observed, "postshiba-webhook");
		assert.equal(await m.Suppression.countDocuments({ accountId: OTHER_ACCOUNT }), 0);
	});

	test("the signature stays strict", async () => {
		const forged = await observe(() => m.postshibaRoute.POST(signedRequest([{ event: "bounce", email: "reader@example.com" }], "someone_elses_secret")));
		assert.equal(forged.result.status, 401);
		assert.equal(forged.alerts, 0);
	});
});
