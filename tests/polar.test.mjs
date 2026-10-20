import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { activate, as, callApi, catchRedirect, form, mockPolar, platformEmails, signIn, startTestApp, withEnv } from "./helpers/app.mjs";

// Polar's API is answered by the handler each test gives mockPolar; events are signed like Polar signs them. Stripe's keys
// stay set: Polar's token wins, which is the provider switch.
let app;
let m;
let calls;
let subscriptions = new Map();
let productList;
let polarState = "up";

const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const SECRET = "polar_whs_test_secret";
const iso = (seconds) => new Date(seconds * 1000).toISOString();

function product(planId, interval, { amount, ...rest } = {}) {
	const plan = m.plans.getPlan(planId);
	return {
		id: `prod_${planId}_${interval}`,
		name: `FlockStack ${plan.name}`,
		is_archived: false,
		visibility: "public",
		recurring_interval: interval,
		recurring_interval_count: 1,
		prices: [{ amount_type: "fixed", price_amount: amount ?? m.plans.getPrice(plan, interval) * 100, price_currency: "usd", is_archived: false }],
		metadata: { flockstack_plan: planId, interval },
		...rest,
	};
}

// Scale has no products in this Polar, and Pro's monthly one is $99 instead of $59: neither is on sale.
function baseProducts() {
	return [
		{ id: "prod_other", name: "Something else", is_archived: false, recurring_interval: "month", prices: [], metadata: {} },
		...["starter", "growth", "max"].flatMap((planId) => ["month", "year"].map((interval) => product(planId, interval))),
		product("pro", "month", { amount: 9900 }),
		product("pro", "year"),
		// Older than the right Starter product, so it never wins its key.
		product("starter", "month", { id: "prod_starter_old", amount: 100 }),
	];
}

function subscription({ id, accountId, customer = "cus_polar", status = "active", plan = "starter", interval = "month", start = NOW, end = NOW + 30 * DAY, ...rest }) {
	return {
		id,
		status,
		customer_id: customer,
		product_id: `prod_${plan}_${interval}`,
		product: { id: `prod_${plan}_${interval}`, metadata: { flockstack_plan: plan, interval } },
		recurring_interval: interval,
		current_period_start: iso(start),
		current_period_end: iso(end),
		cancel_at_period_end: false,
		ends_at: null,
		ended_at: null,
		metadata: accountId ? { accountId: String(accountId) } : {},
		customer: { id: customer, external_id: accountId ? String(accountId) : null },
		...rest,
	};
}

function polarApi({ method, origin, path, query, body, headers }) {
	calls.push({ method, origin, path, query, body, headers });
	if (polarState === "down") return { status: 500, error: "Polar is having a bad day" };
	if (method === "GET" && path === "/v1/products/") {
		// Eight products to a page, to read more than one page.
		const page = Number(query.get("page"));
		return { items: productList.slice((page - 1) * 8, page * 8), pagination: { total_count: productList.length, max_page: Math.ceil(productList.length / 8) } };
	}
	if (method === "GET" && path === "/v1/subscriptions/") {
		const owned = [...subscriptions.values()].filter(({ customer }) => customer.external_id === query.get("external_customer_id"));
		return { items: owned, pagination: { total_count: owned.length, max_page: 1 } };
	}
	if (method === "GET" && path.startsWith("/v1/subscriptions/")) {
		return subscriptions.get(path.split("/").at(-1)) ?? { status: 404, error: "Subscription not found" };
	}
	if (method === "POST" && path === "/v1/checkouts/") return { id: "chk_1", url: "https://checkout.polar.sh/checkout/chk_1" };
	if (method === "POST" && path === "/v1/customer-sessions/") return { id: "cst_1", customer_portal_url: "https://polar.sh/flockstack/portal?customer_session_token=cst_1" };
	return { status: 404, error: `No mock for ${method} ${path}` };
}

let eventCount = 0;
async function deliver(type, data, { secret = SECRET, timestamp = Math.floor(Date.now() / 1000), keyIndex = 0, headers = {} } = {}) {
	const body = JSON.stringify({ type, timestamp: iso(timestamp), data });
	const id = `msg_${++eventCount}`;
	const signature = await m.webhook.sign({ secret, id, timestamp, body, keyIndex });
	const response = await m.webhook.route.POST(
		new Request("http://localhost:3000/api/webhooks/polar", {
			method: "POST",
			headers: { "webhook-id": id, "webhook-timestamp": String(timestamp), "webhook-signature": signature, ...headers },
			body,
		})
	);
	return { status: response.status, body: await response.json() };
}

async function createKey(user, name) {
	const { createApiKey } = await import("../app/(app)/api-keys/actions.js");
	return as(user, () => createApiKey(null, form({ name })));
}

const account = (user) => m.Account.findById(user.accountId).lean();

// lib/polar.js reads the products again once its 10 minutes are up, and retries after a failure a minute later: the clock
// only moves forward in these tests.
const realNow = Date.now;
let skewMinutes = 0;
Date.now = () => realNow() + skewMinutes * 60_000;
const advance = (minutes) => {
	skewMinutes += minutes;
};

before(async () => {
	app = await startTestApp({ POLAR_ACCESS_TOKEN: "polar_oat_test", POLAR_WEBHOOK_SECRET: SECRET });
	const signer = await import("../lib/polar-webhook.js");
	m = {
		webhook: { route: await import("../app/api/webhooks/polar/route.js"), sign: (options) => signer.signPolarWebhook(options), verify: signer.verifyPolarWebhook },
		billing: await import("../app/(account)/billing/actions.js"),
		checkoutRoute: await import("../app/(account)/billing/checkout/route.js"),
		returnRoute: await import("../app/(account)/billing/return/route.js"),
		provider: await import("../lib/billing-provider.js"),
		plans: await import("../lib/plans.js"),
		polar: await import("../lib/polar.js"),
		Account: (await import("../models/Account.js")).default,
	};
	productList = baseProducts();
});

beforeEach(() => {
	calls = [];
	polarState = "up";
	mockPolar(polarApi);
});

after(() => {
	Date.now = realNow;
	return app?.stop();
});

describe("the billing provider", () => {
	test("Polar when its token is set, else Stripe when its key is, else none", () => {
		const { getBillingProvider } = m.provider;
		assert.equal(getBillingProvider({ POLAR_ACCESS_TOKEN: "t", STRIPE_SECRET_KEY: "k" }), "polar");
		assert.equal(getBillingProvider({ POLAR_ACCESS_TOKEN: "t" }), "polar");
		assert.equal(getBillingProvider({ STRIPE_SECRET_KEY: "k" }), "stripe");
		assert.equal(getBillingProvider({ POLAR_ACCESS_TOKEN: "", STRIPE_SECRET_KEY: "k" }), "stripe");
		assert.equal(getBillingProvider({}), "none");
		assert.equal(getBillingProvider({ POLAR_ACCESS_TOKEN: "", STRIPE_SECRET_KEY: "" }), "none");
		assert.equal(getBillingProvider(), "polar", "this server has both keys");
	});

	test("with neither key, plans can't be bought: every plan shows, nothing is created, and the billing page says so", async () => {
		await withEnv({ POLAR_ACCESS_TOKEN: "", STRIPE_SECRET_KEY: "" }, async () => {
			const user = await signIn("none@example.com");
			assert.equal(m.provider.getBillingProvider(), "none");
			assert.equal((await m.provider.findPlansOnSale()).length, 5);
			assert.equal(await as(user, () => catchRedirect(m.billing.choosePlan(form({ plan: "growth", interval: "month" })))), "/billing?interval=month&error=none");
			assert.equal(await as(user, () => catchRedirect(m.billing.openBillingPortal())), "/billing");
			assert.equal(calls.length, 0, "no provider was called");

			const webhook = await m.webhook.route.POST(new Request("http://localhost:3000/api/webhooks/polar", { method: "POST", body: "{}" }));
			assert.equal(webhook.status, 503);
		});
	});

	test("Stripe's token alone leaves Polar unused", async () => {
		await withEnv({ POLAR_ACCESS_TOKEN: "" }, async () => {
			assert.equal(m.provider.getBillingProvider(), "stripe");
			assert.equal(m.polar.isPolarConfigured(), false);
			assert.equal((await m.polar.findPlansOnSale()).length, 5);
		});
		assert.equal(calls.length, 0);
	});
});

describe("plans on sale", () => {
	test("a plan is on sale when both of its products are there at lib/plans.js's amounts; the rest never is", async () => {
		const sale = await m.polar.findPlansOnSale();
		assert.deepEqual(
			sale.map(({ id }) => id),
			["starter", "growth", "max"]
		);
		assert.deepEqual(
			(await m.provider.findPlansOnSale()).map(({ id }) => id),
			["starter", "growth", "max"],
			"the provider switch reads Polar"
		);
		const lists = calls.filter(({ path }) => path === "/v1/products/");
		assert.equal(lists.length, 2, "both pages of the products were read, once");
		assert.equal(lists[0].query.get("is_archived"), "false");
		assert.equal(lists[0].headers.get("authorization"), "Bearer polar_oat_test");
	});

	test("the right product wins its key over an older one with another price", async () => {
		advance(11);
		await m.polar.findPlansOnSale();
		assert.equal(await m.polar.findProductId("starter", "month"), "prod_starter_month");
	});

	test("a plan whose product is mismatched or missing can't be picked, and never reaches Checkout", async () => {
		const user = await signIn("mismatch@example.com");
		for (const plan of ["pro", "scale"]) {
			const url = await as(user, () => catchRedirect(m.billing.choosePlan(form({ plan, interval: "year" }))));
			assert.equal(url, "/billing", `${plan}: the billing page, which shows the plans on sale`);
			const link = await as(user, () => catchRedirect(m.checkoutRoute.GET(new Request(`http://localhost:3000/billing/checkout?plan=${plan}`))));
			assert.equal(link, "/billing?interval=month", `${plan}: the plan buttons too`);
		}
		assert.equal(calls.some(({ path }) => path === "/v1/checkouts/"), false);
		await assert.rejects(m.polar.findProductId("pro", "month"), /at 5900 USD cents/);
		await assert.rejects(m.polar.findProductId("scale", "year"), /No active Polar product/);
	});

	test("an archived, draft, other-currency or two-price product doesn't count", async () => {
		const original = productList;
		try {
			for (const broken of [
				{ is_archived: true },
				{ visibility: "draft" },
				{ recurring_interval_count: 2 },
				{ prices: [{ amount_type: "fixed", price_amount: 2700, price_currency: "eur", is_archived: false }] },
				{ prices: [{ amount_type: "custom", price_currency: "usd", is_archived: false }] },
				{ prices: [{ amount_type: "fixed", price_amount: 2700, price_currency: "usd", is_archived: false }, { amount_type: "fixed", price_amount: 2800, price_currency: "usd", is_archived: false }] },
			]) {
				productList = original.map((item) => (item.id === "prod_growth_month" ? { ...item, ...broken } : item));
				advance(11);
				const sale = await m.polar.findPlansOnSale();
				assert.deepEqual(sale.map(({ id }) => id), ["starter", "max"], JSON.stringify(broken));
			}
		} finally {
			productList = original;
		}
		advance(11);
		assert.deepEqual((await m.polar.findPlansOnSale()).map(({ id }) => id), ["starter", "growth", "max"]);
	});

	test("the sandbox server is read when POLAR_SERVER says so", async () => {
		await withEnv({ POLAR_SERVER: "sandbox" }, async () => {
			advance(11);
			await m.polar.findPlansOnSale();
		});
		assert.equal(calls.at(-1).origin, "https://sandbox-api.polar.sh");
		advance(11);
		await m.polar.findPlansOnSale();
		assert.equal(calls.at(-1).origin, "https://api.polar.sh");
	});
});

describe("checkout", () => {
	test("picking a plan opens Polar's Checkout for the account's own customer", async () => {
		const user = await signIn("checkout@example.com");
		const url = await as(user, () => catchRedirect(m.billing.choosePlan(form({ plan: "growth", interval: "year" }))));
		assert.equal(url, "https://checkout.polar.sh/checkout/chk_1");

		const { body, headers } = calls.findLast(({ path }) => path === "/v1/checkouts/");
		assert.deepEqual(body.products, ["prod_growth_year"]);
		assert.equal(body.external_customer_id, String(user.accountId));
		assert.equal(body.customer_email, "checkout@example.com");
		assert.deepEqual(body.metadata, { accountId: String(user.accountId), plan: "growth", interval: "year" });
		assert.equal(body.success_url, "http://localhost:3000/billing/return?checkout_id={CHECKOUT_ID}");
		assert.equal(body.return_url, "http://localhost:3000/billing?interval=year");
		assert.equal(headers.get("authorization"), "Bearer polar_oat_test");
		assert.equal(calls.some(({ path }) => path.startsWith("/v1/subscriptions")), false);
	});

	test("the plan links and an API key's checkout name the account too; Max has its own products", async () => {
		const user = await signIn("api-checkout@example.com");
		const link = new Request("http://localhost:3000/billing/checkout?plan=max&interval=month");
		assert.equal(await as(user, () => catchRedirect(m.checkoutRoute.GET(link))), "https://checkout.polar.sh/checkout/chk_1");
		assert.deepEqual(calls.findLast(({ path }) => path === "/v1/checkouts/").body.products, ["prod_max_month"]);

		await activate(user);
		const { key } = await createKey(user, "Server");
		await m.Account.updateOne({ _id: user.accountId }, { $set: { subscriptionStatus: "canceled" } });
		const response = await callApi("POST", "/api/v1/billing/change-plan", { key, body: { plan: "growth" } });
		assert.deepEqual(response.body, { url: "https://checkout.polar.sh/checkout/chk_1", kind: "checkout" });
		assert.equal(calls.findLast(({ path }) => path === "/v1/checkouts/").body.external_customer_id, String(user.accountId));
	});

	test("an account that already has a Polar customer checks out as that customer, without an email", async () => {
		const user = await signIn("again@example.com");
		await m.Account.updateOne({ _id: user.accountId }, { $set: { polarCustomerId: "cus_again" } });
		await as(user, () => catchRedirect(m.billing.choosePlan(form({ plan: "starter", interval: "month" }))));
		const { body } = calls.findLast(({ path }) => path === "/v1/checkouts/");
		assert.equal(body.customer_email, undefined);
		assert.equal(body.external_customer_id, String(user.accountId));
	});

	test("get_billing lists the plans on sale from Polar", async () => {
		const user = await signIn("billing-api@example.com");
		await activate(user);
		const { key } = await createKey(user, "Billing");
		const response = await callApi("GET", "/api/v1/billing", { key });
		assert.deepEqual(response.body.plans.map(({ id }) => id), ["starter", "growth", "max"]);
	});
});

describe("webhook signatures", () => {
	test("an event with a wrong or missing signature is refused before anything changes", async () => {
		const forged = await deliver("subscription.updated", { id: "sub_x" }, { secret: "someone_elses_secret" });
		assert.equal(forged.status, 403);
		const unsigned = await m.webhook.route.POST(new Request("http://localhost:3000/api/webhooks/polar", { method: "POST", body: "{}" }));
		assert.equal(unsigned.status, 403);
		const tampered = await m.webhook.sign({ secret: SECRET, id: "msg_t", timestamp: Math.floor(Date.now() / 1000), body: "{}" });
		const edited = await m.webhook.route.POST(
			new Request("http://localhost:3000/api/webhooks/polar", {
				method: "POST",
				headers: { "webhook-id": "msg_t", "webhook-timestamp": String(Math.floor(Date.now() / 1000)), "webhook-signature": tampered },
				body: '{"type":"subscription.updated","data":{"id":"sub_x"}}',
			})
		);
		assert.equal(edited.status, 403, "a signature for another body");
		assert.equal(calls.length, 0, "Polar's API wasn't called");
	});

	test("an old or future timestamp is refused even when it is signed: a captured event can't be sent again", async () => {
		const old = await deliver("subscription.updated", { id: "sub_x" }, { timestamp: Math.floor(Date.now() / 1000) - 600 });
		assert.equal(old.status, 403);
		const future = await deliver("subscription.updated", { id: "sub_x" }, { timestamp: Math.floor(Date.now() / 1000) + 600 });
		assert.equal(future.status, 403);
		const fresh = await deliver("customer.created", { id: "cus_x" }, { timestamp: Math.floor(Date.now() / 1000) - 240 });
		assert.equal(fresh.status, 200);
		assert.equal(calls.length, 0);
	});

	test("a malformed signature next to a good one doesn't spoil it; another version's signature is ignored", async () => {
		const timestamp = Math.floor(Date.now() / 1000);
		const body = JSON.stringify({ type: "customer.created", data: {} });
		const good = await m.webhook.sign({ secret: SECRET, id: "msg_m", timestamp, body });
		for (const signature of [`v1,!!!not-base64 ${good}`, `v2,${good.slice(3)} ${good}`]) {
			assert.equal(await m.webhook.verify({ body, headers: new Headers({ "webhook-id": "msg_m", "webhook-timestamp": String(timestamp), "webhook-signature": signature }), secret: SECRET }), true, signature);
		}
		assert.equal(await m.webhook.verify({ body, headers: new Headers({ "webhook-id": "msg_m", "webhook-timestamp": String(timestamp), "webhook-signature": "v2,abc" }), secret: SECRET }), false);
	});

	test("a Standard Webhooks secret (whsec_ and base64) verifies too, signed with its decoded key", async () => {
		const secret = `whsec_${Buffer.from("a-standard-webhooks-key-0123456789").toString("base64")}`;
		await withEnv({ POLAR_WEBHOOK_SECRET: secret }, async () => {
			assert.equal((await deliver("customer.created", {}, { secret, keyIndex: 1 })).status, 200, "the decoded key");
			assert.equal((await deliver("customer.created", {}, { secret, keyIndex: 0 })).status, 200, "the text key, for secrets made before 8 September 2026");
			assert.equal((await deliver("customer.created", {}, { secret: "whsec_c29tZW9uZWVsc2U=" })).status, 403);
		});
	});

	test("without the webhook secret the endpoint is off, and other event types are acknowledged and ignored", async () => {
		await withEnv({ POLAR_WEBHOOK_SECRET: "" }, async () => {
			const response = await m.webhook.route.POST(new Request("http://localhost:3000/api/webhooks/polar", { method: "POST", body: "{}" }));
			assert.equal(response.status, 503);
		});
		assert.deepEqual(await deliver("refund.created", { id: "ref_1" }), { status: 200, body: { received: true, ignored: "refund.created" } });
	});

	test("a signed body that isn't JSON answers 400", async () => {
		const timestamp = Math.floor(Date.now() / 1000);
		const signature = await m.webhook.sign({ secret: SECRET, id: "msg_j", timestamp, body: "nope" });
		const response = await m.webhook.route.POST(
			new Request("http://localhost:3000/api/webhooks/polar", { method: "POST", headers: { "webhook-id": "msg_j", "webhook-timestamp": String(timestamp), "webhook-signature": signature }, body: "nope" })
		);
		assert.equal(response.status, 400);
	});

	test("a self-hosted server has no billing endpoint", async () => {
		await withEnv({ FLOCKSTACK_CLOUD: "" }, async () => {
			assert.equal((await m.webhook.route.POST(new Request("http://localhost:3000/api/webhooks/polar", { method: "POST", body: "{}" }))).status, 404);
		});
	});
});

describe("subscription changes", () => {
	let user;

	before(async () => {
		user = await signIn("lifecycle@example.com");
	});

	test("a new subscription turns the plan on and starts the month", async () => {
		subscriptions.set("sub_life", subscription({ id: "sub_life", accountId: user.accountId, plan: "growth" }));
		const result = await deliver("subscription.created", { id: "sub_life" });
		assert.deepEqual(result, { status: 200, body: { received: true, updated: true, status: "active" } });

		const paid = await account(user);
		assert.equal(paid.polarCustomerId, "cus_polar");
		assert.equal(paid.polarSubscriptionId, "sub_life");
		assert.equal(paid.stripeSubscriptionId, undefined);
		assert.equal(paid.subscriptionStatus, "active");
		assert.equal(paid.plan, "growth");
		assert.equal(paid.interval, "month");
		assert.equal(paid.currentPeriodStart.getTime(), NOW * 1000);
		assert.equal(paid.currentPeriodEnd.getTime(), (NOW + 30 * DAY) * 1000);
		assert.equal(paid.usage.emailsSent, 0);
		assert.equal(paid.usage.paidThrough.getTime(), (NOW + 30 * DAY) * 1000);
		assert.ok((await createKey(user, "Paid")).key, "what needs a plan opens");
	});

	test("an upgrade changes the plan; a scheduled cancel is shown, and undone", async () => {
		subscriptions.set("sub_life", subscription({ id: "sub_life", accountId: user.accountId, plan: "max", interval: "year", end: NOW + 365 * DAY }));
		await deliver("subscription.updated", { id: "sub_life" });
		let current = await account(user);
		assert.deepEqual([current.plan, current.interval], ["max", "year"]);
		assert.deepEqual(m.plans.getAccountLimits(current), { emails: 2_000_000, subscribers: 400_000 });

		subscriptions.set("sub_life", { ...subscriptions.get("sub_life"), cancel_at_period_end: true, ends_at: iso(NOW + 365 * DAY) });
		await deliver("subscription.canceled", { id: "sub_life" });
		current = await account(user);
		assert.equal(current.cancelAt.getTime(), (NOW + 365 * DAY) * 1000);
		assert.equal(current.subscriptionStatus, "active", "the plan works until the period ends");

		subscriptions.set("sub_life", { ...subscriptions.get("sub_life"), cancel_at_period_end: false, ends_at: null });
		await deliver("subscription.uncanceled", { id: "sub_life" });
		assert.equal((await account(user)).cancelAt, undefined);
	});

	test("the event's own copy is never trusted: the subscription is read from Polar", async () => {
		const result = await deliver("subscription.updated", { id: "sub_life", status: "canceled", product: { metadata: {} } });
		assert.deepEqual(result, { status: 200, body: { received: true, updated: true, status: "active" } });
		assert.equal((await account(user)).subscriptionStatus, "active");
	});

	test("a failed payment keeps the plan working, as past_due", async () => {
		subscriptions.set("sub_life", { ...subscriptions.get("sub_life"), status: "past_due" });
		await deliver("subscription.past_due", { id: "sub_life" });
		const current = await account(user);
		assert.equal(current.subscriptionStatus, "past_due");
		assert.ok((await createKey(user, "Past due")).key);
	});

	test("when Polar can't be read the webhook answers 500, so Polar retries, and the admins hear of it", async () => {
		const error = console.error;
		console.error = () => {};
		const emailsBefore = platformEmails.length;
		try {
			const result = await deliver("subscription.updated", { id: "sub_missing" });
			assert.equal(result.status, 500);
		} finally {
			console.error = error;
		}
		const [alert] = platformEmails.slice(emailsBefore);
		assert.deepEqual([alert.to, alert.subject], [["admin@example.com"], "[FlockStack] Polar event not handled"]);
		assert.match(alert.text, new RegExp(`subscription\\.updated msg_${eventCount}: Polar answered 404`));
		assert.match(alert.text, /Polar retries it 10 times/);
	});

	test("a product without our plan metadata keeps the plan and logs it", async () => {
		const logged = [];
		const error = console.error;
		console.error = (...args) => logged.push(args.join(" "));
		try {
			subscriptions.set("sub_life", { ...subscription({ id: "sub_life", accountId: user.accountId }), product: { id: "prod_old", metadata: {} }, recurring_interval: "week" });
			await deliver("subscription.updated", { id: "sub_life" });
		} finally {
			console.error = error;
		}
		assert.equal((await account(user)).plan, "max");
		assert.ok(logged.some((line) => line.includes("without our plan metadata")));
	});

	test("an older subscription ending doesn't cancel the current one", async () => {
		subscriptions.set("sub_old", subscription({ id: "sub_old", accountId: user.accountId, status: "canceled" }));
		const result = await deliver("subscription.revoked", { id: "sub_old" });
		assert.equal(result.body.ignored, "an older subscription");
		assert.equal((await account(user)).subscriptionStatus, "active");
	});

	test("revoking the subscription puts the account back on Free: its data and last plan are kept, its limits are Free's", async () => {
		const { key } = await createKey(user, "Site");
		subscriptions.set("sub_life", subscription({ id: "sub_life", accountId: user.accountId, status: "canceled", plan: "max", interval: "year", ended_at: iso(NOW) }));
		await deliver("subscription.revoked", { id: "sub_life" });

		const ended = await account(user);
		assert.equal(ended.subscriptionStatus, "canceled");
		assert.equal(ended.plan, "max", "the data and the last plan are kept");
		assert.equal(ended.cancelAt, undefined);
		assert.equal((await createKey(user, "Another")).code, undefined, "an account on Free still makes keys");
		const response = await callApi("GET", "/api/v1/billing", { key });
		assert.equal(response.status, 200);
		assert.deepEqual(
			{ plan: response.body.plan.id, price: response.body.plan.price, status: response.body.status, lapsedPlan: response.body.lapsedPlan, emails: response.body.usage.emailsLimit, isActive: response.body.isActive },
			{ plan: "free", price: 0, status: "free", lapsedPlan: "max", emails: 10000, isActive: true }
		);
	});

	test("a Free account upgrades through the same checkout as a first purchase, and comes back to Free when it ends", async () => {
		const free = await signIn("free-upgrade@example.com");
		assert.equal(m.plans.getAccountPlan(await account(free)).id, "free", "no subscription is the Free plan");
		assert.equal(m.plans.getAccountPlan(await account(free)).monthlyPrice, 0);

		const picked = await as(free, () => catchRedirect(m.billing.choosePlan(form({ plan: "growth", interval: "month" }))));
		assert.equal(picked, "https://checkout.polar.sh/checkout/chk_1", "Checkout, not the portal: there's no subscription to change");
		const link = await as(free, () => catchRedirect(m.checkoutRoute.GET(new Request("http://localhost:3000/billing/checkout?plan=growth&interval=month"))));
		assert.equal(link, "https://checkout.polar.sh/checkout/chk_1", "the pricing page's buttons too");
		const checkout = calls.findLast(({ path }) => path === "/v1/checkouts/");
		assert.equal(checkout.body.external_customer_id, String(free.accountId));
		assert.equal(checkout.body.metadata.accountId, String(free.accountId));
		assert.equal(calls.some(({ path }) => path === "/v1/customer-sessions/"), false);
		assert.equal(await as(free, () => catchRedirect(m.checkoutRoute.GET(new Request("http://localhost:3000/billing/checkout?plan=free")))), "/billing?interval=month", "Free has no checkout");

		await m.Account.updateOne({ _id: free.accountId }, { $set: { "usage.emailsSent": 4_321 } });
		subscriptions.set("sub_free_up", subscription({ id: "sub_free_up", accountId: free.accountId, customer: "cus_free_up", plan: "growth" }));
		assert.equal((await deliver("subscription.created", { id: "sub_free_up" })).body.updated, true);
		let upgraded = await account(free);
		assert.equal(m.plans.getAccountPlan(upgraded).id, "growth");
		assert.deepEqual(m.plans.getAccountLimits(upgraded), { emails: 125_000, subscribers: 25_000 });
		assert.equal(upgraded.usage.emailsSent, 0, "the paid month starts from zero");
		assert.equal(upgraded.usage.paidThrough.getTime(), (NOW + 30 * DAY) * 1000);

		subscriptions.set("sub_free_up", subscription({ id: "sub_free_up", accountId: free.accountId, customer: "cus_free_up", plan: "growth", status: "canceled", ended_at: iso(NOW) }));
		await deliver("subscription.revoked", { id: "sub_free_up" });
		upgraded = await account(free);
		assert.equal(m.plans.getAccountPlan(upgraded).id, "free", "cancelling returns to Free");
		assert.deepEqual(m.plans.getAccountLimits(upgraded), { emails: 10_000, subscribers: 2_500 });
		assert.equal(upgraded.plan, "growth", "its last plan is remembered");
	});

	test("a new subscription after a canceled one replaces it and starts a new month", async () => {
		subscriptions.set("sub_new", subscription({ id: "sub_new", accountId: user.accountId, plan: "starter", start: NOW + 400 * DAY, end: NOW + 430 * DAY }));
		await deliver("subscription.active", { id: "sub_new" });
		const current = await account(user);
		assert.deepEqual([current.polarSubscriptionId, current.plan, current.subscriptionStatus], ["sub_new", "starter", "active"]);
		assert.equal(current.usage.periodStart.getTime(), (NOW + 400 * DAY) * 1000);
	});

	test("a subscription naming two different accounts, or none that exists, changes nothing", async () => {
		const other = await signIn("other-claim@example.com");
		subscriptions.set("sub_two", subscription({ id: "sub_two", accountId: user.accountId, customer: "cus_two", metadata: { accountId: String(other.accountId) } }));
		subscriptions.set("sub_none", subscription({ id: "sub_none", customer: "cus_none" }));
		const info = console.info;
		console.info = () => {};
		try {
			assert.equal((await deliver("subscription.created", { id: "sub_two" })).body.ignored, "no account");
			assert.equal((await deliver("subscription.created", { id: "sub_none" })).body.ignored, "no account");
		} finally {
			console.info = info;
		}
		assert.equal((await account(other)).subscriptionStatus, undefined);
	});

	test("a Polar customer belongs to one account", async () => {
		const first = await signIn("customer-one@example.com");
		const second = await signIn("customer-two@example.com");
		await m.Account.updateOne({ _id: first.accountId }, { $set: { polarCustomerId: "cus_shared" } });
		await assert.rejects(m.Account.updateOne({ _id: second.accountId }, { $set: { polarCustomerId: "cus_shared" } }), { code: 11000 });
	});
});

describe("renewals", () => {
	test("a paid renewal starts the month over; the same order again doesn't", async () => {
		const user = await signIn("renewals@example.com");
		subscriptions.set("sub_ren", subscription({ id: "sub_ren", accountId: user.accountId, customer: "cus_ren" }));
		await deliver("subscription.created", { id: "sub_ren" });
		await m.Account.updateOne({ _id: user.accountId }, { $set: { "usage.emailsSent": 12_345 } });

		const first = { id: "ord_1", billing_reason: "subscription_create", subscription_id: "sub_ren" };
		assert.equal((await deliver("order.paid", first)).body.reset, false, "the first order pays the period already started");
		assert.equal((await account(user)).usage.emailsSent, 12_345);

		subscriptions.set("sub_ren", subscription({ id: "sub_ren", accountId: user.accountId, customer: "cus_ren", start: NOW + 30 * DAY, end: NOW + 60 * DAY }));
		const renewal = { id: "ord_2", billing_reason: "subscription_cycle", subscription_id: "sub_ren" };
		assert.equal((await deliver("order.paid", renewal)).body.reset, true);
		let current = await account(user);
		assert.equal(current.usage.emailsSent, 0);
		assert.equal(current.usage.periodStart.getTime(), (NOW + 30 * DAY) * 1000);
		assert.equal(current.currentPeriodEnd.getTime(), (NOW + 60 * DAY) * 1000);

		await m.Account.updateOne({ _id: user.accountId }, { $inc: { "usage.emailsSent": 40 } });
		assert.equal((await deliver("order.paid", renewal)).body.reset, false, "redelivered");
		current = await account(user);
		assert.equal(current.usage.emailsSent, 40, "emails sent since the renewal still count");

		const upgrade = { id: "ord_3", billing_reason: "subscription_update", subscription_id: "sub_ren" };
		assert.equal((await deliver("order.paid", upgrade)).body.reset, false, "a mid-period plan change keeps the count");
		assert.equal((await deliver("order.paid", { id: "ord_4", billing_reason: "purchase", subscription_id: null })).body.ignored, "not a subscription order");

		subscriptions.set("sub_gone", subscription({ id: "sub_gone", accountId: user.accountId, customer: "cus_ren" }));
		const oldSubscription = { id: "ord_5", billing_reason: "subscription_cycle", subscription_id: "sub_gone" };
		assert.equal((await deliver("order.paid", oldSubscription)).body.ignored, "an older subscription");
	});

	test("a lost subscription event is made up by the order that follows it", async () => {
		const user = await signIn("lost-event@example.com");
		subscriptions.set("sub_lost", subscription({ id: "sub_lost", accountId: user.accountId, customer: "cus_lost", plan: "growth" }));
		const result = await deliver("order.paid", { id: "ord_lost", billing_reason: "subscription_create", subscription_id: "sub_lost" });
		assert.equal(result.body.updated, true);
		assert.deepEqual([(await account(user)).plan, (await account(user)).subscriptionStatus], ["growth", "active"]);
	});
});

describe("coming back from Checkout", () => {
	test("the plan is on before the webhook, then the dashboard opens", async () => {
		const user = await signIn("returning@example.com");
		subscriptions.set("sub_return", subscription({ id: "sub_return", accountId: user.accountId, customer: "cus_return" }));
		const url = await as(user, () => catchRedirect(m.returnRoute.GET(new Request("http://localhost:3000/billing/return?checkout_id=chk_1"))));
		assert.equal(url, "/");
		assert.equal((await account(user)).subscriptionStatus, "active");
		assert.equal(calls.find(({ path }) => path === "/v1/subscriptions/").query.get("external_customer_id"), String(user.accountId));
	});

	test("another account's subscription doesn't turn a plan on, and without one the billing page waits for the webhook", async () => {
		const owner = await signIn("owner@example.com");
		const visitor = await signIn("visitor@example.com");
		subscriptions.set("sub_owner", subscription({ id: "sub_owner", accountId: owner.accountId, customer: "cus_owner" }));
		const url = await as(visitor, () => catchRedirect(m.returnRoute.GET(new Request("http://localhost:3000/billing/return?checkout_id=chk_owner"))));
		assert.equal(url, "/billing?checkout=pending");
		assert.equal((await account(visitor)).subscriptionStatus, undefined);
		assert.equal((await account(owner)).subscriptionStatus, undefined, "nothing changed for the owner either");
	});

	test("a Polar that can't be read leaves the pending page, which the webhook then resolves", async () => {
		const user = await signIn("return-down@example.com");
		polarState = "down";
		const error = console.error;
		console.error = () => {};
		try {
			assert.equal(await as(user, () => catchRedirect(m.returnRoute.GET(new Request("http://localhost:3000/billing/return")))), "/billing?checkout=pending");
		} finally {
			console.error = error;
		}
	});
});

describe("customer portal", () => {
	test("manage billing opens the portal for the stored customer; picking another plan opens it too, never a second checkout", async () => {
		const user = await signIn("portal@example.com");
		subscriptions.set("sub_portal", subscription({ id: "sub_portal", accountId: user.accountId, customer: "cus_portal" }));
		await deliver("subscription.created", { id: "sub_portal" });

		const portalUrl = "https://polar.sh/flockstack/portal?customer_session_token=cst_1";
		assert.equal(await as(user, () => catchRedirect(m.billing.openBillingPortal())), portalUrl);
		const { body } = calls.findLast(({ path }) => path === "/v1/customer-sessions/");
		assert.deepEqual(body, { customer_id: "cus_portal", return_url: "http://localhost:3000/billing" });

		assert.equal(await as(user, () => catchRedirect(m.billing.choosePlan(form({ plan: "growth", interval: "month" })))), portalUrl);
		assert.equal(calls.some(({ path }) => path === "/v1/checkouts/"), false, "a paying account never gets a second subscription");
	});

	test("the API says portal for a plan change and returns the portal link", async () => {
		const user = await signIn("portal-api@example.com");
		subscriptions.set("sub_papi", subscription({ id: "sub_papi", accountId: user.accountId, customer: "cus_papi" }));
		await deliver("subscription.created", { id: "sub_papi" });
		const { key } = await createKey(user, "Portal");
		const change = await callApi("POST", "/api/v1/billing/change-plan", { key, body: { plan: "max", interval: "year" } });
		assert.deepEqual(change.body, { url: "https://polar.sh/flockstack/portal?customer_session_token=cst_1", kind: "portal" });
		const portal = await callApi("POST", "/api/v1/billing/portal", { key });
		assert.equal(portal.body.url, "https://polar.sh/flockstack/portal?customer_session_token=cst_1");
	});

	test("an account that never paid has no portal", async () => {
		const user = await signIn("noportal@example.com");
		assert.equal(await as(user, () => catchRedirect(m.billing.openBillingPortal())), "/billing");
		assert.equal(calls.some(({ path }) => path === "/v1/customer-sessions/"), false);
	});

	test("a portal Polar can't open sends the owner back to billing with the reason", async () => {
		const user = await signIn("portal-down@example.com");
		await activate(user, { polarCustomerId: "cus_pd" });
		polarState = "down";
		const error = console.error;
		console.error = () => {};
		try {
			assert.equal(await as(user, () => catchRedirect(m.billing.openBillingPortal())), "/billing?error=polar");
		} finally {
			console.error = error;
		}
	});
});

describe("canceling", () => {
	test("canceling in the portal keeps the plan until the period ends, then the revocation ends it", async () => {
		const user = await signIn("cancel@example.com");
		subscriptions.set("sub_cancel", subscription({ id: "sub_cancel", accountId: user.accountId, customer: "cus_cancel" }));
		await deliver("subscription.created", { id: "sub_cancel" });

		subscriptions.set("sub_cancel", { ...subscriptions.get("sub_cancel"), cancel_at_period_end: true, ends_at: null });
		await deliver("subscription.canceled", { id: "sub_cancel" });
		let current = await account(user);
		assert.equal(current.subscriptionStatus, "active");
		assert.equal(current.cancelAt.getTime(), (NOW + 30 * DAY) * 1000, "without ends_at, the period's end");

		const { getDeletionBlockers } = await import("../lib/account-deletion.js");
		assert.equal((await getDeletionBlockers(current)).hasPlan, true, "a plan Polar still bills keeps the account from being deleted");

		subscriptions.set("sub_cancel", { ...subscriptions.get("sub_cancel"), status: "canceled", ended_at: iso(NOW + 30 * DAY) });
		await deliver("subscription.revoked", { id: "sub_cancel" });
		current = await account(user);
		assert.equal(current.subscriptionStatus, "canceled");
		assert.equal(current.cancelAt, undefined);
		assert.equal(await getDeletionBlockers(current), null);
	});
});

describe("when Polar is down", () => {
	test("every plan shows for a minute, Checkout still refuses a product it can't find, and the products come back after", async () => {
		const user = await signIn("down@example.com");
		const error = console.error;
		console.error = () => {};
		try {
			advance(11);
			polarState = "down";
			assert.equal((await m.polar.findPlansOnSale()).length, 5);
			const listed = calls.length;
			assert.equal((await m.polar.findPlansOnSale()).length, 5);
			assert.equal(calls.length, listed, "not asked again within the minute");
			assert.equal(await as(user, () => catchRedirect(m.billing.choosePlan(form({ plan: "max", interval: "year" })))), "/billing?interval=year&error=polar");
			assert.equal(calls.some(({ path }) => path === "/v1/checkouts/"), false);
		} finally {
			console.error = error;
		}
		polarState = "up";
		advance(2);
		assert.deepEqual((await m.polar.findPlansOnSale()).map(({ id }) => id), ["starter", "growth", "max"]);
	});
});
