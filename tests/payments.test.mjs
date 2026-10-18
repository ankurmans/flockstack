import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { activate, anonymous, as, mockStripe, signIn, startTestApp, withEnv } from "./helpers/app.mjs";
import { createFakeStripe } from "./stubs/stripe-connect.mjs";

// Payments for what creators sell, apart from FlockStack's own plan billing: how a server is set up (Stripe Connect on
// FlockStack Cloud, the owner's own key when self-hosted), Stripe's REST API, signed webhooks and connected accounts.
const SECRET = "whsec_test_payments_secret";
let app;
let m;
let fake;
let seller;

async function post(event, { secret = SECRET, timestamp = Math.floor(Date.now() / 1000), header, body = JSON.stringify(event) } = {}) {
	const signature = header ?? (await m.signature.signStripePayload({ secret, body, timestamp }));
	const request = new Request("http://localhost:3000/api/webhooks/payments", { method: "POST", headers: { "stripe-signature": signature }, body });
	const response = await anonymous(() => m.webhook.POST(request));
	return { status: response.status, body: await response.json() };
}

async function reloadSeller() {
	seller.account = await m.Account.findById(seller.accountId).lean();
	return seller.account;
}

before(async () => {
	app = await startTestApp({ STRIPE_PAYMENTS_WEBHOOK_SECRET: SECRET });
	m = {
		config: await import("../lib/payments/config.js"),
		signature: await import("../lib/payments/signature.js"),
		api: await import("../lib/payments/stripe-api.js"),
		connect: await import("../lib/payments/connect.js"),
		webhook: await import("../app/api/webhooks/payments/route.js"),
		Account: (await import("../models/Account.js")).default,
		PaymentEvent: (await import("../models/PaymentEvent.js")).default,
	};
	seller = await signIn("seller@example.com");
	await activate(seller);
});

after(() => app?.stop());

beforeEach(() => {
	fake = createFakeStripe();
	mockStripe(fake.handler);
});

describe("how a server takes payments", () => {
	test("FlockStack Cloud connects creators' own Stripe accounts, a self-hosted server uses its owner's key", () => {
		assert.equal(m.config.getPaymentsMode({ FLOCKSTACK_CLOUD: "true", STRIPE_SECRET_KEY: "sk_test_a" }), "connect");
		assert.equal(m.config.getPaymentsMode({ STRIPE_SECRET_KEY: "sk_test_a" }), "direct");
		assert.equal(m.config.getPaymentsMode({ FLOCKSTACK_CLOUD: "true" }), "none");
		assert.equal(m.config.getPaymentsMode({}), "none");
		assert.equal(m.config.getPaymentsSecretKey({ FLOCKSTACK_CLOUD: "true", STRIPE_CONNECT_SECRET_KEY: "sk_test_connect", STRIPE_SECRET_KEY: "sk_test_plans" }), "sk_test_connect");
		assert.equal(m.config.getPaymentsSecretKey({ STRIPE_CONNECT_SECRET_KEY: "sk_test_connect", STRIPE_SECRET_KEY: "sk_test_own" }), "sk_test_own", "a self-hosted server never reads the Connect key");
	});

	test("an account is ready once its Stripe account takes charges, and a self-hosted server always is", async () => {
		const unconnected = m.connect.getPaymentsState({ payments: {} });
		assert.deepEqual([unconnected.mode, unconnected.ready, unconnected.connected], ["connect", false, false]);
		assert.match(unconnected.problem, /Connect your Stripe account/);
		const pending = m.connect.getPaymentsState({ payments: { stripeAccountId: "acct_1", chargesEnabled: false } });
		assert.deepEqual([pending.ready, pending.connected], [false, true]);
		assert.match(pending.problem, /Finish setting up/);
		assert.equal(m.connect.getPaymentsState({ payments: { stripeAccountId: "acct_1", chargesEnabled: true } }).ready, true);
		const left = m.connect.getPaymentsState({ payments: { stripeAccountId: "acct_1", chargesEnabled: true, deauthorizedAt: new Date() } });
		assert.deepEqual([left.ready, left.connected], [false, false]);
		await withEnv({ FLOCKSTACK_CLOUD: "" }, () => {
			const own = m.connect.getPaymentsState({});
			assert.deepEqual([own.mode, own.ready, own.stripeAccountId], ["direct", true, null]);
			assert.equal(m.connect.getChargeAccount({ payments: { stripeAccountId: "acct_1" } }), undefined, "its key is the account");
		});
		await withEnv({ STRIPE_SECRET_KEY: "", STRIPE_CONNECT_SECRET_KEY: "" }, () => {
			assert.deepEqual([m.connect.getPaymentsState({}).mode, m.connect.getPaymentsState({}).ready], ["none", false]);
			assert.throws(() => m.connect.assertPaymentsReady({}), { code: "payments_not_ready" });
		});
	});
});

describe("Stripe's REST API", () => {
	test("nested parameters are form encoded the way Stripe reads them", () => {
		assert.deepEqual(
			m.api.encodeParams({ mode: "payment", line_items: [{ quantity: 1, price_data: { currency: "usd" } }], metadata: { a: "1" }, skipped: undefined, empty: null, flag: true }),
			[
				["mode", "payment"],
				["line_items[0][quantity]", "1"],
				["line_items[0][price_data][currency]", "usd"],
				["metadata[a]", "1"],
				["flag", "true"],
			]
		);
	});

	test("a charge on a connected account carries the Stripe-Account header and the platform key", async () => {
		fake.accounts.set("acct_seller", { id: "acct_seller" });
		await m.api.stripeRequest("/v1/checkout/sessions", { method: "POST", account: "acct_seller", params: { mode: "payment" } });
		const [request] = fake.requests;
		assert.equal(request.account, "acct_seller");
		assert.equal(request.authorization, "Bearer sk_test_flockstack");
	});

	test("no application fee ever goes out, whatever the call asks for", async () => {
		for (const params of [
			{ payment_intent_data: { application_fee_amount: 100 } },
			{ subscription_data: { application_fee_percent: 10 } },
			{ nested: [{ application_fee_amount: 1 }] },
		]) {
			await assert.rejects(m.api.stripeRequest("/v1/checkout/sessions", { method: "POST", account: "acct_seller", params }), /never takes an application fee/);
		}
		assert.equal(fake.requests.length, 0, "refused before anything reached Stripe");
	});

	test("Stripe's errors keep their code and status", async () => {
		await assert.rejects(m.api.stripeRequest("/v1/accounts/acct_missing"), (error) => error.name === "StripeError" && error.status === 404 && error.stripeCode === "resource_missing");
	});
});

describe("webhook signatures", () => {
	const body = '{"id":"evt_1"}';
	const timestamp = Math.floor(Date.now() / 1000);

	test("a signature made with the endpoint's secret on the exact body passes", async () => {
		const header = await m.signature.signStripePayload({ secret: SECRET, body, timestamp });
		assert.equal(await m.signature.verifyStripeSignature({ body, header, secret: SECRET }), true);
		assert.equal(await m.signature.verifyStripeSignature({ body, header: `${header},v1=${"0".repeat(64)}`, secret: SECRET }), true, "a second signature next to a good one");
	});

	test("another secret, a changed body, a missing or malformed header and an old timestamp are refused", async () => {
		const header = await m.signature.signStripePayload({ secret: SECRET, body, timestamp });
		assert.equal(await m.signature.verifyStripeSignature({ body, header, secret: "whsec_other" }), false);
		assert.equal(await m.signature.verifyStripeSignature({ body: `${body} `, header, secret: SECRET }), false);
		assert.equal(await m.signature.verifyStripeSignature({ body, header: null, secret: SECRET }), false);
		assert.equal(await m.signature.verifyStripeSignature({ body, header: "garbage", secret: SECRET }), false);
		assert.equal(await m.signature.verifyStripeSignature({ body, header: `t=${timestamp}`, secret: SECRET }), false);
		assert.equal(await m.signature.verifyStripeSignature({ body, header, secret: "" }), false);
		const old = timestamp - 600;
		const stale = await m.signature.signStripePayload({ secret: SECRET, body, timestamp: old });
		assert.equal(await m.signature.verifyStripeSignature({ body, header: stale, secret: SECRET }), false, "ten minutes old");
		assert.equal(await m.signature.verifyStripeSignature({ body, header: stale, secret: SECRET, now: old * 1000 + 60_000 }), true, "a minute old when it was sent");
	});
});

describe("the payments webhook route", () => {
	test("answers 400 to a bad signature and does nothing", async () => {
		const event = fake.event("account.updated", { id: "acct_x", charges_enabled: true }, { account: "acct_x" });
		assert.equal((await post(event, { secret: "whsec_wrong" })).status, 400);
		assert.equal((await post(event, { header: "t=1,v1=abc" })).status, 400);
		assert.equal(await m.PaymentEvent.countDocuments({ accountId: seller.accountId }), 0);
	});

	test("answers 503 without a webhook secret and 404 without payments", async () => {
		const event = fake.event("account.updated", { id: "acct_x" }, { account: "acct_x" });
		await withEnv({ STRIPE_PAYMENTS_WEBHOOK_SECRET: "" }, async () => assert.equal((await post(event)).status, 503));
		await withEnv({ STRIPE_SECRET_KEY: "", STRIPE_CONNECT_SECRET_KEY: "" }, async () => assert.equal((await post(event)).status, 404));
	});

	test("rejects a signed body that isn't an event", async () => {
		assert.equal((await post(null, { body: "not json" })).status, 400);
		assert.equal((await post(null, { body: JSON.stringify({ hello: "world" }) })).status, 400);
	});

	test("ignores events of accounts and kinds it doesn't know, with a 200 so Stripe stops sending them", async () => {
		const unknown = await post(fake.event("account.updated", { id: "acct_stranger", charges_enabled: true }, { account: "acct_stranger" }));
		assert.deepEqual([unknown.status, unknown.body.ignored], [200, "unknown account"]);
		const other = await post(fake.event("customer.created", { id: "cus_1" }, { account: "acct_stranger" }));
		assert.deepEqual([other.status, other.body.ignored], [200, "customer.created"]);
	});
});

describe("connecting a Stripe account", () => {
	test("onboarding creates one Standard account for the FlockStack account and a hosted link to finish it", async () => {
		const first = await m.connect.createConnectOnboarding({ account: await reloadSeller(), email: "seller@example.com" });
		assert.match(first.url, /^https:\/\/connect\.stripe\.test\/onboard\/acct_test_/);
		const created = fake.requests.find(({ path }) => path === "/v1/accounts");
		assert.equal(created.params.type, "standard");
		assert.equal(created.params.metadata.accountId, String(seller.accountId));
		assert.equal(created.params.email, "seller@example.com");
		assert.equal(created.idempotencyKey, `flockstack-connect-${seller.accountId}`, "two clicks at once make one account");
		const link = fake.requests.find(({ path }) => path === "/v1/account_links");
		assert.equal(link.params.type, "account_onboarding");
		assert.equal(link.params.return_url, "http://localhost:3000/payments?connect=return");
		assert.equal(link.params.refresh_url, "http://localhost:3000/payments?connect=refresh");

		const account = await reloadSeller();
		assert.equal(account.payments.stripeAccountId, first.stripeAccountId);

		const again = await m.connect.createConnectOnboarding({ account, email: "seller@example.com" });
		assert.equal(again.stripeAccountId, first.stripeAccountId, "a creator who comes back resumes the same account");
		assert.equal(fake.requests.filter(({ path }) => path === "/v1/accounts").length, 1);
	});

	test("the status check asks Stripe and keeps what it says", async () => {
		const account = await reloadSeller();
		assert.equal(m.connect.getPaymentsState(account).ready, false);
		fake.accounts.set(account.payments.stripeAccountId, { id: account.payments.stripeAccountId, charges_enabled: false, payouts_enabled: false, details_submitted: true, country: "US" });
		let fresh = await m.connect.refreshPaymentsStatus(account);
		assert.deepEqual([fresh.payments.chargesEnabled, fresh.payments.detailsSubmitted], [false, true]);
		assert.equal(m.connect.getPaymentsState(fresh).ready, false);

		fake.completeOnboarding(account.payments.stripeAccountId);
		fresh = await m.connect.refreshPaymentsStatus(fresh);
		assert.equal(m.connect.getPaymentsState(fresh).ready, true);
		assert.equal(fresh.payments.country, "US");
		assert.ok(fresh.payments.checkedAt);
	});

	test("account.updated from the connected account keeps the flags current, and a repeat is skipped by its id", async () => {
		const stripeAccountId = (await reloadSeller()).payments.stripeAccountId;
		const event = fake.event("account.updated", { id: stripeAccountId, charges_enabled: false, payouts_enabled: false, details_submitted: true, country: "US" }, { account: stripeAccountId });
		const first = await post(event);
		assert.deepEqual([first.status, first.body.handled], [200, "account.updated"]);
		assert.equal((await reloadSeller()).payments.chargesEnabled, false);

		const enabled = fake.event("account.updated", { id: stripeAccountId, charges_enabled: true, payouts_enabled: true, details_submitted: true, country: "US" }, { account: stripeAccountId });
		assert.equal((await post(enabled)).body.handled, "account.updated");
		assert.equal(m.connect.getPaymentsState(await reloadSeller()).ready, true);

		// Stripe delivers the old event again, late: its id was handled, so it can't undo the newer state.
		const replay = await post(event);
		assert.deepEqual([replay.status, replay.body.duplicate], [200, true]);
		assert.equal(m.connect.getPaymentsState(await reloadSeller()).ready, true);
		assert.equal(await m.PaymentEvent.countDocuments({ accountId: seller.accountId, eventId: event.id }), 1);
	});

	test("an event for another FlockStack account's Stripe account never touches this one", async () => {
		const other = await signIn("other-seller@example.com");
		await m.Account.updateOne({ _id: other.accountId }, { $set: { "payments.stripeAccountId": "acct_other", "payments.chargesEnabled": true } });
		const before = await reloadSeller();
		await post(fake.event("account.updated", { id: "acct_other", charges_enabled: false }, { account: "acct_other" }));
		assert.equal((await m.Account.findById(other.accountId).lean()).payments.chargesEnabled, false);
		assert.deepEqual((await reloadSeller()).payments, before.payments);
	});

	test("disconnecting FlockStack in Stripe turns charges off, and connecting again makes a new account", async () => {
		const account = await reloadSeller();
		const stripeAccountId = account.payments.stripeAccountId;
		await post(fake.event("account.application.deauthorized", { id: "ca_flockstack" }, { account: stripeAccountId }));
		const left = await reloadSeller();
		assert.equal(m.connect.getPaymentsState(left).ready, false);
		assert.match(m.connect.getPaymentsState(left).problem, /disconnected/);

		const again = await m.connect.createConnectOnboarding({ account: left, email: "seller@example.com" });
		assert.notEqual(again.stripeAccountId, stripeAccountId);
		const fresh = await reloadSeller();
		assert.equal(fresh.payments.stripeAccountId, again.stripeAccountId);
		assert.equal(fresh.payments.deauthorizedAt, undefined);
	});

	test("a self-hosted server has nothing to connect", async () => {
		await withEnv({ FLOCKSTACK_CLOUD: "" }, () =>
			assert.rejects(m.connect.createConnectOnboarding({ account: seller.account, email: "seller@example.com" }), /nothing to connect/)
		);
	});

	test("the dashboard user's own session isn't needed by a webhook", async () => {
		// Webhooks come from Stripe, never a signed-in user: a request with a user's cookies is checked the same way.
		const event = fake.event("account.updated", { id: "acct_x" }, { account: "acct_x" });
		const request = new Request("http://localhost:3000/api/webhooks/payments", { method: "POST", body: JSON.stringify(event) });
		assert.equal((await as(seller, () => m.webhook.POST(request))).status, 400);
	});
});
