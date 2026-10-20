import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { as, callApi, catchRedirect, form, mockPolar, signIn, startTestApp } from "./helpers/app.mjs";
import { platformEmails } from "./helpers/app.mjs";
import { calls as sesCalls, leaseIp, state as ses } from "./stubs/ses.mjs";

// The dedicated IP add-on: a Polar subscription next to the plan's, answered here by a stub of Polar's API and signed
// webhook events, and the inventory of leased IPs in the SES stub. At cost: $27 a month on Pro, Scale and Max, monthly
// only. Paid before it turns on, off when it ends or the plan drops below Pro.
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
	if (addon) {
		return {
			id: "prod_ip_month",
			is_archived: false,
			recurring_interval: "month",
			recurring_interval_count: 1,
			prices: [{ amount_type: "fixed", price_amount: amount ?? m.plans.DEDICATED_IP_PRICE * 100, price_currency: "usd", is_archived: false }],
			metadata: { interval: "month", flockstack_addon: "dedicated_ip" },
		};
	}
	return {
		id: `prod_${planId}_${interval}`,
		is_archived: false,
		recurring_interval: interval,
		recurring_interval_count: 1,
		prices: [{ amount_type: "fixed", price_amount: amount ?? m.plans.getPrice(m.plans.getPlan(planId), interval) * 100, price_currency: "usd", is_archived: false }],
		metadata: { flockstack_plan: planId, interval },
	};
}

const PRODUCTS = () => [
	...m.plans.PLAN_IDS.flatMap((planId) => ["month", "year"].map((interval) => product(planId, interval))),
	product(null, "month", { addon: true }),
];

function subscription({ id, user, plan, interval = "month", addon = false, status = "active", ...rest }) {
	const productId = addon ? "prod_ip_month" : `prod_${plan}_${interval}`;
	return {
		id,
		status,
		customer_id: `cus_${user.email}`,
		product_id: productId,
		product: { id: productId, metadata: addon ? { interval: "month", flockstack_addon: "dedicated_ip" } : { flockstack_plan: plan, interval } },
		prices: [],
		recurring_interval: addon ? "month" : interval,
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
	if (method === "GET" && path === "/v1/products/") return { items: PRODUCTS(), pagination: { total_count: 11, max_page: 1 } };
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
async function customer(email, plan, interval = "month") {
	const user = await signIn(email);
	subscriptions.set(`sub_plan_${email.split("@")[0]}`, subscription({ id: `sub_plan_${email.split("@")[0]}`, user, plan, interval }));
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
		inventory: await import("../lib/ip-inventory.js"),
		DedicatedIp: (await import("../models/DedicatedIp.js")).default,
		Alert: (await import("../models/Alert.js")).default,
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

// An IP AWS leased (the stub), added to the inventory as an admin would.
async function addFreeIp(ip) {
	leaseIp(ip);
	const result = await m.inventory.addIp({ ip, by: "ops@example.com" });
	assert.deepEqual(result, { ip });
}

// Retires every free IP, so the next add-on finds none.
async function emptyInventory() {
	for (const doc of await m.DedicatedIp.find({ state: "available" }).lean()) await m.inventory.retireIp(doc.ip);
}

async function payAddon(user, plan, name) {
	const id = `sub_ip_${name}`;
	subscriptions.set(id, subscription({ id, user, plan, addon: true }));
	return deliver("subscription.active", { id });
}

describe("the price", () => {
	test("at cost: $27 a month on Pro, Scale and Max, monthly only, and never under what AWS and Polar charge us", () => {
		const { DEDICATED_IP_PRICE, DEDICATED_IP_AWS_MONTHLY_COST, POLAR_FEE, getDedicatedIpPrice, getNetAfterPolar } = m.plans;
		assert.deepEqual([DEDICATED_IP_PRICE, DEDICATED_IP_AWS_MONTHLY_COST, POLAR_FEE], [27, 24.95, { rate: 0.04, fixed: 0.4 }]);
		assert.deepEqual(["pro", "scale", "max"].map((id) => getDedicatedIpPrice(id)), [27, 27, 27], "the same on every plan from Pro up");
		assert.deepEqual(["starter", "growth", "free", undefined].map((id) => getDedicatedIpPrice(id)), [null, null, null, null]);
		// The test that keeps it above water: a change of the price, AWS's or Polar's fee can't silently put it under.
		assert.ok(DEDICATED_IP_PRICE * (1 - POLAR_FEE.rate) - POLAR_FEE.fixed >= DEDICATED_IP_AWS_MONTHLY_COST, "the price nets less than the lease");
		assert.equal(getNetAfterPolar(DEDICATED_IP_PRICE), 25.52);
		assert.equal(Math.ceil(((DEDICATED_IP_AWS_MONTHLY_COST + POLAR_FEE.fixed) / (1 - POLAR_FEE.rate)) * 100) / 100, 26.41, "the price that breaks even");
		assert.ok(getNetAfterPolar(DEDICATED_IP_PRICE) - DEDICATED_IP_AWS_MONTHLY_COST < 1, "no markup: under a dollar of rounding");
	});
});

describe("buying it", () => {
	test("Pro and above can add it at $27 a month; Growth, Starter and Free can't", async () => {
		const pro = await customer("ip-pro@example.com", "pro");
		const status = await billing(pro);
		assert.deepEqual(status, { isOn: false, state: "off", address: null, warmup: null, available: true, price: 27, interval: "month", subscription: null });

		const url = await as(pro, () => catchRedirect(m.billing.addDedicatedIp()));
		assert.equal(url, "https://checkout.polar.sh/checkout/chk_ip");
		const checkout = calls.find(({ path }) => path === "/v1/checkouts/").body;
		assert.deepEqual(checkout.products, ["prod_ip_month"]);
		assert.equal(checkout.external_customer_id, String(pro.accountId));
		assert.deepEqual([checkout.metadata.addon, checkout.metadata.plan, checkout.metadata.interval], ["dedicated_ip", "pro", "month"]);
		assert.match(checkout.success_url, /\/billing\/return\?addon=dedicated_ip&checkout_id=/);

		for (const plan of ["growth", "starter"]) {
			const user = await customer(`ip-${plan}@example.com`, plan);
			assert.equal((await billing(user)).available, false, plan);
			assert.equal((await billing(user)).price, null, plan);
			const refused = await callApi("POST", "/api/v1/billing/dedicated-ip", { key: user.key });
			assert.equal(refused.status, 409, plan);
			assert.match(refused.body.error.message, /for the Pro, Scale and Max plans/);
		}
		const free = await signIn("ip-free@example.com");
		free.key = (await as(free, () => m.apiKeys.createApiKey(null, form({ name: "Agent" })))).key;
		const refusedFree = await callApi("POST", "/api/v1/billing/dedicated-ip", { key: free.key });
		assert.ok([402, 409].includes(refusedFree.status), `Free can't buy it: ${refusedFree.status}`);
		assert.equal((await account(free)).dedicatedIp?.polarSubscriptionId, undefined);
	});

	test("a yearly plan holds the monthly add-on next to it, at the same price", async () => {
		const user = await customer("ip-yearly@example.com", "scale", "year");
		assert.deepEqual(await billing(user), { isOn: false, state: "off", address: null, warmup: null, available: true, price: 27, interval: "month", subscription: null });
		await as(user, () => catchRedirect(m.billing.addDedicatedIp()));
		const checkout = calls.find(({ path }) => path === "/v1/checkouts/").body;
		assert.deepEqual([checkout.products, checkout.metadata.interval], [["prod_ip_month"], "month"], "monthly, whatever the plan's interval");
	});

	test("paid with an IP free, it is set up: a pool, the IP moved in, a second configuration set, and a warm-up on day 1", async () => {
		await addFreeIp("203.0.113.10");
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
		const pool = `mc-ip-${user.accountId}`;
		const dedicatedSet = `${current.ses.configurationSet}-ip`;
		assert.deepEqual([current.ses.dedicatedPool, current.ses.dedicatedIpAddress, current.ses.dedicatedConfigurationSet], [pool, "203.0.113.10", dedicatedSet]);
		assert.deepEqual([current.ses.ipWarmup.day, current.ses.ipWarmup.share, current.ses.ipWarmup.holds], [1, 2, 0]);
		assert.ok(current.dedicatedIp.turnedOnAt);
		assert.equal(current.dedicatedIp.waitingAt, undefined);

		assert.ok(ses.pools.has(pool));
		assert.equal(ses.dedicatedIps.get("203.0.113.10").poolName, pool, "moved out of the parking pool into the account's");
		assert.deepEqual(
			[ses.dedicatedIps.get("203.0.113.10").warmupStatus, ses.dedicatedIps.get("203.0.113.10").warmupPercentage],
			["DONE", 100],
			"SES's own warm-up is ended: ours is the only ramp"
		);
		assert.equal(ses.configurationSetPools.get(dedicatedSet), pool);
		assert.equal(ses.configurationSetPools.has(current.ses.configurationSet), false, "the shared set has no pool");
		assert.ok(ses.associations.get(current.ses.tenantName).has(`configuration-set/${dedicatedSet}`), "SES sends a tenant's email only through sets it owns");
		const doc = await m.DedicatedIp.findOne({ ip: "203.0.113.10" }).lean();
		assert.deepEqual([doc.state, String(doc.accountId), doc.poolName], ["warming", String(user.accountId), pool]);
		const mail = platformEmails.findLast(({ subject }) => subject === "Your dedicated IP is warming up");
		assert.ok(mail?.to.includes("ip-paid@example.com"), "the owner is told it's warming up");
		assert.deepEqual([current.polarSubscriptionId, current.plan, current.subscriptionStatus], [before.polarSubscriptionId, "scale", "active"], "the plan is the plan's");

		// A renewal of the add-on pays for the add-on: the plan's emails don't start over, and the IP isn't set up twice.
		await m.Account.updateOne({ _id: user.accountId }, { $set: { "usage.emailsSent": 42 } });
		const created = sesCalls.filter(({ name }) => name === "createDedicatedIpPool").length;
		await deliver("order.paid", { id: "ord_ip", subscription_id: "sub_ip_paid", billing_reason: "subscription_cycle" });
		assert.equal((await account(user)).usage.emailsSent, 42);
		assert.equal(sesCalls.filter(({ name }) => name === "createDedicatedIpPool").length, created);

		const status = await billing(user);
		assert.deepEqual([status.isOn, status.state, status.address, status.available], [true, "warming", "203.0.113.10", false]);
		assert.deepEqual(status.warmup, { day: 1, days: 30, share: 2, isDone: false, isHeld: false });
		assert.equal(status.subscription.status, "active");
	});

	test("paid with no IP free, it waits: the customer is told it's being prepared, the admins are alerted, and an IP added later is given at once", async () => {
		const user = await customer("ip-wait@example.com", "pro");
		const answer = await payAddon(user, "pro", "wait");
		assert.deepEqual(answer.body, { received: true, addon: "dedicated_ip", status: "active", dedicatedIp: "waiting" });
		let current = await account(user);
		assert.ok(current.dedicatedIp.waitingAt);
		assert.equal(current.dedicatedIp.turnedOnAt, undefined);
		assert.equal(current.ses.dedicatedPool, undefined);
		assert.equal(ses.pools.has(`mc-ip-${user.accountId}`), false, "nothing is created at AWS for a waiting add-on");
		const status = await billing(user);
		assert.deepEqual([status.isOn, status.state, status.address], [false, "waiting", null]);
		assert.ok(await m.Alert.findOne({ key: `ip-inventory:waiting:${user.accountId}` }).lean(), "an admin alert");
		await m.inventory.checkInventoryLevel();
		assert.ok(await m.Alert.findOne({ key: "ip-inventory:empty" }).lean(), "and the inventory's");

		// Every hour it tries again; nothing changes while none is free, and nothing is re-alerted.
		const alerts = await m.Alert.countDocuments({});
		await m.dedicatedIp.followDedicatedIps();
		assert.equal((await account(user)).dedicatedIp.turnedOnAt, undefined);
		assert.equal(await m.Alert.countDocuments({}), alerts);

		// An admin adds an IP: the waiting add-on turns on by itself.
		leaseIp("203.0.113.11");
		const admin = await signIn("admin@example.com");
		const added = await as(admin, () => m.admin.addIpAction("203.0.113.11", "second"));
		assert.deepEqual([added.ok, added.ip, added.assigned], [true, "203.0.113.11", 1]);
		current = await account(user);
		assert.equal(current.ses.dedicatedIpAddress, "203.0.113.11");
		assert.ok(current.dedicatedIp.turnedOnAt);
		assert.equal(current.dedicatedIp.waitingAt, undefined);
		assert.equal((await billing(user)).state, "warming");
	});

	test("the checkout's return comes back to billing and reads the add-on there", async () => {
		await addFreeIp("203.0.113.12");
		const user = await customer("ip-return@example.com", "max");
		subscriptions.set("sub_ip_return", subscription({ id: "sub_ip_return", user, plan: "max", addon: true }));
		const route = await import("../app/(account)/billing/return/route.js");
		const url = await as(user, () => catchRedirect(route.GET(new Request("http://localhost:3000/billing/return?addon=dedicated_ip&checkout_id=chk_ip"))));
		assert.equal(url, "/billing?addon=dedicated_ip");
		assert.equal((await account(user)).ses.dedicatedIpAddress, "203.0.113.12");
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
	async function withAddon(email, plan, ip) {
		await addFreeIp(ip);
		const user = await customer(email, plan);
		await payAddon(user, plan, email.split("@")[0]);
		assert.equal((await account(user)).ses.dedicatedIpAddress, ip);
		return user;
	}

	test("a canceled add-on stays on to the end of its period, then the IP goes back to the inventory and the account to shared IPs", async () => {
		const user = await withAddon("ip-cancel@example.com", "pro", "203.0.113.20");
		const addon = subscriptions.get("sub_ip_ip-cancel");
		Object.assign(addon, { cancel_at_period_end: true, ends_at: addon.current_period_end });
		await deliver("subscription.canceled", { id: addon.id });
		assert.equal((await account(user)).ses.dedicatedIpAddress, "203.0.113.20", "paid to the end");
		assert.ok((await account(user)).dedicatedIp.cancelAt);

		addon.status = "canceled";
		await deliver("subscription.revoked", { id: addon.id });
		const current = await account(user);
		const set = `${current.ses.configurationSet}-ip`;
		assert.deepEqual([current.ses.dedicatedPool, current.ses.dedicatedIpAddress, current.ses.dedicatedConfigurationSet, current.ses.ipWarmup], [undefined, undefined, undefined, undefined]);
		assert.equal(current.dedicatedIp.turnedOnAt, undefined);
		assert.equal(ses.pools.has(`mc-ip-${user.accountId}`), false, "the pool is deleted: SES allows 50");
		assert.equal(ses.configurationSetPools.has(set), false);
		assert.equal(ses.dedicatedIps.get("203.0.113.20").poolName, m.inventory.PARKING_POOL, "parked again, not in SES's default pool");
		const doc = await m.DedicatedIp.findOne({ ip: "203.0.113.20" }).lean();
		assert.deepEqual([doc.state, doc.accountId, String(doc.lastAccountId)], ["available", undefined, String(user.accountId)]);
		assert.match(doc.notes, /Returned by account .* It carries that account's sending history/);
		assert.ok(doc.releasedAt);
		assert.equal((await billing(user)).state, "off");
	});

	test("a plan dropping below Pro cancels the add-on at its period's end and takes the IP back at once", async () => {
		const user = await withAddon("ip-downgrade@example.com", "pro", "203.0.113.21");
		const plan = subscriptions.get("sub_plan_ip-downgrade");
		Object.assign(plan, { product_id: "prod_growth_month", product: { id: "prod_growth_month", metadata: { flockstack_plan: "growth", interval: "month" } } });
		await deliver("subscription.updated", { id: plan.id });
		const cancel = calls.find(({ method, path }) => method === "PATCH" && path === "/v1/subscriptions/sub_ip_ip-downgrade");
		assert.deepEqual(cancel?.body, { cancel_at_period_end: true });
		const current = await account(user);
		assert.equal(current.plan, "growth");
		assert.equal(current.ses.dedicatedIpAddress, undefined);
		assert.ok(current.dedicatedIp.cancelAt);
		assert.equal((await m.DedicatedIp.findOne({ ip: "203.0.113.21" }).lean()).state, "available");
	});

	test("a move between Pro, Scale and Max changes nothing: the add-on costs the same on all three", async () => {
		const user = await withAddon("ip-upgrade@example.com", "pro", "203.0.113.22");
		const plan = subscriptions.get("sub_plan_ip-upgrade");
		Object.assign(plan, { product_id: "prod_max_month", product: { id: "prod_max_month", metadata: { flockstack_plan: "max", interval: "month" } } });
		await deliver("subscription.updated", { id: plan.id });
		assert.equal(calls.some(({ method, path }) => method === "PATCH" && path === "/v1/subscriptions/sub_ip_ip-upgrade"), false, "no product change");
		const current = await account(user);
		assert.deepEqual([current.plan, current.ses.dedicatedIpAddress, (await billing(user)).state], ["max", "203.0.113.22", "warming"]);
	});

	test("an add-on canceled while it waits for an IP stops waiting", async () => {
		await emptyInventory();
		const user = await customer("ip-waitcancel@example.com", "pro");
		await payAddon(user, "pro", "waitcancel");
		assert.ok((await account(user)).dedicatedIp.waitingAt);
		const addon = subscriptions.get("sub_ip_waitcancel");
		addon.status = "canceled";
		await deliver("subscription.revoked", { id: addon.id });
		const current = await account(user);
		assert.equal(current.dedicatedIp.waitingAt, undefined);
		assert.equal((await billing(user)).state, "off");
	});

	test("an IP an admin gave by hand stays when no add-on asks for it, and the admin's Assign an IP still works", async () => {
		await addFreeIp("203.0.113.23");
		const user = await customer("ip-admin@example.com", "growth");
		const admin = await signIn("admin@example.com");
		assert.deepEqual(await as(admin, () => m.admin.setDedicatedIp(String(user.accountId), true)), { ok: true, ip: "203.0.113.23" });
		await m.dedicatedIp.syncDedicatedIp(await account(user));
		assert.equal((await account(user)).ses.dedicatedIpAddress, "203.0.113.23");
		assert.equal(await m.dedicatedIp.followDedicatedIps(), 0);
		assert.equal((await account(user)).ses.dedicatedIpAddress, "203.0.113.23");
		assert.deepEqual(await as(admin, () => m.admin.setDedicatedIp(String(user.accountId), false)), { ok: true, ip: "203.0.113.23" });
		assert.equal((await account(user)).ses.dedicatedIpAddress, undefined);
		assert.equal((await m.DedicatedIp.findOne({ ip: "203.0.113.23" }).lean()).state, "available");
		assert.equal(sesCalls.some(({ name }) => name === "deleteDedicatedIpPool"), true);
	});
});
