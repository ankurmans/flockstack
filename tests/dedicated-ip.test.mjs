import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { as, callApi, catchRedirect, form, mockPolar, signIn, startTestApp } from "./helpers/app.mjs";
import { calls as sesCalls, state as ses } from "./stubs/ses.mjs";

// The dedicated IP add-on: a Polar subscription next to the plan's, answered here by a stub of Polar's API and signed
// webhook events, and an IP pool in the SES stub. Paid before it turns on, off when it ends or the plan drops below Pro.
const SECRET = "polar_whs_test_secret";
const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const iso = (seconds) => new Date(seconds * 1000).toISOString();
let app;
let m;
let calls;
let subscriptions;
let eventCount = 0;

function product(planId, interval, { addon, amount } = {}) {
	const price = addon ? m.plans.getDedicatedIpPrice(planId, interval) : m.plans.getPrice(m.plans.getPlan(planId), interval);
	return {
		id: `prod_${addon ? "ip_" : ""}${planId}_${interval}`,
		is_archived: false,
		recurring_interval: interval,
		recurring_interval_count: 1,
		prices: [{ amount_type: "fixed", price_amount: amount ?? price * 100, price_currency: "usd", is_archived: false }],
		metadata: { flockstack_plan: planId, interval, ...(addon && { flockstack_addon: "dedicated_ip" }) },
	};
}

const PRODUCTS = () => [
	...m.plans.PLAN_IDS.flatMap((planId) => ["month", "year"].map((interval) => product(planId, interval))),
	...["pro", "scale", "max"].flatMap((planId) => ["month", "year"].map((interval) => product(planId, interval, { addon: true }))),
];

function subscription({ id, user, plan, interval = "month", addon = false, status = "active", ...rest }) {
	const productId = `prod_${addon ? "ip_" : ""}${plan}_${interval}`;
	return {
		id,
		status,
		customer_id: `cus_${user.email}`,
		product_id: productId,
		product: { id: productId, metadata: { flockstack_plan: plan, interval, ...(addon && { flockstack_addon: "dedicated_ip" }) } },
		prices: [],
		recurring_interval: interval,
		current_period_start: iso(NOW),
		current_period_end: iso(NOW + 30 * DAY),
		cancel_at_period_end: false,
		ends_at: null,
		metadata: { accountId: String(user.accountId), ...(addon && { addon: "dedicated_ip" }) },
		customer: { id: `cus_${user.email}`, external_id: String(user.accountId) },
		...rest,
	};
}

function polarApi({ method, path, query, body }) {
	calls.push({ method, path, body });
	if (method === "GET" && path === "/v1/products/") return { items: PRODUCTS(), pagination: { total_count: 26, max_page: 1 } };
	if (method === "GET" && path === "/v1/subscriptions/") {
		const owned = [...subscriptions.values()].filter(({ customer }) => customer.external_id === query.get("external_customer_id"));
		return { items: owned, pagination: { total_count: owned.length, max_page: 1 } };
	}
	if (path.startsWith("/v1/subscriptions/")) {
		const found = subscriptions.get(path.split("/").at(-1));
		if (!found) return { status: 404, error: "Subscription not found" };
		if (method === "PATCH" && body.cancel_at_period_end) Object.assign(found, { cancel_at_period_end: true, ends_at: found.current_period_end });
		if (method === "PATCH" && body.product_id) {
			const next = PRODUCTS().find(({ id }) => id === body.product_id);
			Object.assign(found, { product_id: next.id, product: { id: next.id, metadata: next.metadata } });
		}
		return found;
	}
	if (method === "POST" && path === "/v1/checkouts/") return { id: "chk_ip", url: "https://checkout.polar.sh/checkout/chk_ip" };
	return { status: 404, error: `No mock for ${method} ${path}` };
}

async function deliver(type, data) {
	const timestamp = Math.floor(Date.now() / 1000);
	const body = JSON.stringify({ type, timestamp: iso(timestamp), data });
	const id = `msg_ip_${++eventCount}`;
	const signature = await m.signer.signPolarWebhook({ secret: SECRET, id, timestamp, body });
	const response = await m.webhook.POST(
		new Request("http://localhost:3000/api/webhooks/polar", {
			method: "POST",
			headers: { "webhook-id": id, "webhook-timestamp": String(timestamp), "webhook-signature": signature },
			body,
		})
	);
	return { status: response.status, body: await response.json() };
}

// A paying Polar customer on a plan, with its SES tenant, as the plan's webhook leaves it.
async function customer(email, plan) {
	const user = await signIn(email);
	subscriptions.set(`sub_plan_${email.split("@")[0]}`, subscription({ id: `sub_plan_${email.split("@")[0]}`, user, plan }));
	assert.equal((await deliver("subscription.active", { id: `sub_plan_${email.split("@")[0]}` })).status, 200);
	user.key = (await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Agent" })))).key;
	return user;
}

const account = (user) => m.Account.findById(user.accountId).lean();

async function billing(user) {
	const response = await callApi("GET", "/api/v1/billing", { key: user.key });
	assert.equal(response.status, 200, JSON.stringify(response.body));
	return response.body.dedicatedIp;
}

before(async () => {
	app = await startTestApp({ POLAR_ACCESS_TOKEN: "polar_oat_test", POLAR_WEBHOOK_SECRET: SECRET });
	m = {
		webhook: await import("../app/api/webhooks/polar/route.js"),
		signer: await import("../lib/polar-webhook.js"),
		billing: await import("../app/(account)/billing/actions.js"),
		apiKeys: await import("../app/(app)/api-keys/actions.js"),
		admin: await import("../app/admin/actions.js"),
		dedicatedIp: await import("../lib/dedicated-ip.js"),
		plans: await import("../lib/plans.js"),
		Account: (await import("../models/Account.js")).default,
	};
	subscriptions = new Map();
});

beforeEach(() => {
	calls = [];
	mockPolar(polarApi);
});

after(() => app?.stop());

describe("buying it", () => {
	test("Pro and above can add it, at their plan's price; Growth can't", async () => {
		const pro = await customer("ip-pro@example.com", "pro");
		assert.deepEqual(await billing(pro), { isOn: false, available: true, price: 35, interval: "month", subscription: null });

		const url = await as(pro, () => catchRedirect(m.billing.addDedicatedIp()));
		assert.equal(url, "https://checkout.polar.sh/checkout/chk_ip");
		const checkout = calls.find(({ path }) => path === "/v1/checkouts/").body;
		assert.deepEqual(checkout.products, ["prod_ip_pro_month"]);
		assert.equal(checkout.external_customer_id, String(pro.accountId));
		assert.deepEqual([checkout.metadata.addon, checkout.metadata.plan], ["dedicated_ip", "pro"]);
		assert.match(checkout.success_url, /\/billing\/return\?addon=dedicated_ip&checkout_id=/);

		const growth = await customer("ip-growth@example.com", "growth");
		assert.equal((await billing(growth)).available, false);
		const refused = await callApi("POST", "/api/v1/billing/dedicated-ip", { key: growth.key });
		assert.equal(refused.status, 409);
		assert.match(refused.body.error.message, /for the Pro, Scale and Max plans/);
		assert.deepEqual(
			["scale", "max"].map((planId) => ["month", "year"].map((interval) => m.plans.getDedicatedIpPrice(planId, interval))),
			[
				[69, 690],
				[269, 2690],
			]
		);
	});

	test("it turns on once paid, not before, without touching the plan's subscription or month", async () => {
		const user = await customer("ip-paid@example.com", "scale");
		const before = await account(user);
		subscriptions.set("sub_ip_paid", subscription({ id: "sub_ip_paid", user, plan: "scale", addon: true, status: "incomplete" }));
		await deliver("subscription.created", { id: "sub_ip_paid" });
		let current = await account(user);
		assert.equal(current.ses.dedicatedPool, undefined, "not paid yet");
		assert.equal(current.dedicatedIp.status, "incomplete");

		subscriptions.get("sub_ip_paid").status = "active";
		const answer = await deliver("subscription.active", { id: "sub_ip_paid" });
		assert.deepEqual(answer.body, { received: true, addon: "dedicated_ip", status: "active", dedicatedIp: "on" });
		current = await account(user);
		assert.equal(current.ses.dedicatedPool, `mc-${user.accountId}`);
		assert.ok(ses.pools.has(`mc-${user.accountId}`));
		assert.ok(current.dedicatedIp.turnedOnAt);
		assert.deepEqual([current.polarSubscriptionId, current.plan, current.subscriptionStatus], [before.polarSubscriptionId, "scale", "active"], "the plan is the plan's");

		// A renewal of the add-on pays for the add-on: the plan's emails don't start over.
		await m.Account.updateOne({ _id: user.accountId }, { $set: { "usage.emailsSent": 42 } });
		await deliver("order.paid", { id: "ord_ip", subscription_id: "sub_ip_paid", billing_reason: "subscription_cycle" });
		assert.equal((await account(user)).usage.emailsSent, 42);

		const status = await billing(user);
		assert.equal(status.isOn, true);
		assert.equal(status.available, false, "one at a time");
		assert.deepEqual([status.subscription.status, status.subscription.plan], ["active", "scale"]);
	});

	test("the checkout's return comes back to billing and reads the add-on there", async () => {
		const user = await customer("ip-return@example.com", "max");
		subscriptions.set("sub_ip_return", subscription({ id: "sub_ip_return", user, plan: "max", addon: true }));
		const route = await import("../app/(account)/billing/return/route.js");
		const url = await as(user, () => catchRedirect(route.GET(new Request("http://localhost:3000/billing/return?addon=dedicated_ip&checkout_id=chk_ip"))));
		assert.equal(url, "/billing?addon=dedicated_ip");
		assert.equal((await account(user)).ses.dedicatedPool, `mc-${user.accountId}`);
	});
});

describe("the plan's own subscription", () => {
	test("carrying the extra emails price lets the account send extra emails; a product from before the price doesn't", async () => {
		const user = await customer("extra-price@example.com", "growth");
		const plan = subscriptions.get("sub_plan_extra-price");
		const metered = { amount_type: "metered_unit", unit_amount: "0.015", meter: { id: "meter_1", name: "Extra emails" }, is_archived: false };
		plan.prices = [{ amount_type: "fixed", price_amount: 2900, price_currency: "usd", is_archived: false }, metered];
		await deliver("subscription.updated", { id: plan.id });
		let current = await account(user);
		assert.equal(current.extraEmails.billable, true);
		assert.equal(m.plans.getExtraEmailsLimit(current), 125_000);

		plan.prices = plan.prices.slice(0, 1);
		await deliver("subscription.updated", { id: plan.id });
		current = await account(user);
		assert.equal(current.extraEmails.billable, false);
		assert.equal(m.plans.getExtraEmailsLimit(current), 0);
	});
});

describe("ending it", () => {
	async function withAddon(email, plan) {
		const user = await customer(email, plan);
		subscriptions.set(`sub_ip_${email.split("@")[0]}`, subscription({ id: `sub_ip_${email.split("@")[0]}`, user, plan, addon: true }));
		await deliver("subscription.active", { id: `sub_ip_${email.split("@")[0]}` });
		assert.equal((await account(user)).ses.dedicatedPool, `mc-${user.accountId}`);
		return user;
	}

	test("a canceled add-on stays on to the end of its period, then the IP goes back to shared", async () => {
		const user = await withAddon("ip-cancel@example.com", "pro");
		const addon = subscriptions.get("sub_ip_ip-cancel");
		Object.assign(addon, { cancel_at_period_end: true, ends_at: addon.current_period_end });
		await deliver("subscription.canceled", { id: addon.id });
		assert.equal((await account(user)).ses.dedicatedPool, `mc-${user.accountId}`, "paid to the end");
		assert.ok((await account(user)).dedicatedIp.cancelAt);

		addon.status = "canceled";
		await deliver("subscription.revoked", { id: addon.id });
		const current = await account(user);
		assert.equal(current.ses.dedicatedPool, undefined);
		assert.equal(current.dedicatedIp.turnedOnAt, undefined);
		assert.equal(ses.pools.has(`mc-${user.accountId}`), false);
	});

	test("a plan dropping below Pro cancels the add-on at its period's end and turns the IP off at once", async () => {
		const user = await withAddon("ip-downgrade@example.com", "pro");
		const plan = subscriptions.get("sub_plan_ip-downgrade");
		Object.assign(plan, { product_id: "prod_growth_month", product: { id: "prod_growth_month", metadata: { flockstack_plan: "growth", interval: "month" } } });
		await deliver("subscription.updated", { id: plan.id });
		const cancel = calls.find(({ method, path }) => method === "PATCH" && path === "/v1/subscriptions/sub_ip_ip-downgrade");
		assert.deepEqual(cancel?.body, { cancel_at_period_end: true });
		const current = await account(user);
		assert.equal(current.plan, "growth");
		assert.equal(current.ses.dedicatedPool, undefined);
		assert.ok(current.dedicatedIp.cancelAt);
	});

	test("a move between Pro, Scale and Max moves the add-on to that plan's price", async () => {
		const user = await withAddon("ip-upgrade@example.com", "pro");
		const plan = subscriptions.get("sub_plan_ip-upgrade");
		Object.assign(plan, { product_id: "prod_max_month", product: { id: "prod_max_month", metadata: { flockstack_plan: "max", interval: "month" } } });
		await deliver("subscription.updated", { id: plan.id });
		const move = calls.find(({ method, path }) => method === "PATCH" && path === "/v1/subscriptions/sub_ip_ip-upgrade");
		assert.deepEqual(move?.body, { product_id: "prod_ip_max_month" });
		const current = await account(user);
		assert.deepEqual([current.dedicatedIp.plan, Boolean(current.ses.dedicatedPool)], ["max", true]);
	});

	test("a dedicated IP an admin gave by hand stays when no add-on asks for it, and the admin toggle still works", async () => {
		const user = await customer("ip-admin@example.com", "growth");
		const admin = await signIn("admin@example.com");
		assert.deepEqual(await as(admin, () => m.admin.setDedicatedIp(String(user.accountId), true)), { ok: true });
		await m.dedicatedIp.syncDedicatedIp(await account(user));
		assert.equal((await account(user)).ses.dedicatedPool, `mc-${user.accountId}`);
		assert.equal(await m.dedicatedIp.followDedicatedIps(), 0);
		assert.equal((await account(user)).ses.dedicatedPool, `mc-${user.accountId}`);
		assert.deepEqual(await as(admin, () => m.admin.setDedicatedIp(String(user.accountId), false)), { ok: true });
		assert.equal(sesCalls.some(({ name }) => name === "deleteDedicatedIpPool"), true);
	});
});
