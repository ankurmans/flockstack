import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { activate, as, catchNotFound, signIn, startTestApp } from "./helpers/app.mjs";
import { leaseIp, relinquishIp, state as ses } from "./stubs/ses.mjs";

// The inventory of standard dedicated IPs the owner leased at AWS (there is no API to lease one), what an admin does with
// it, and what an account is given from it.
let app;
let m;
let admin;
let provider;

before(async () => {
	app = await startTestApp({ ADMIN_EMAILS: "ops@example.com" });
	m = {
		inventory: await import("../lib/ip-inventory.js"),
		assignment: await import("../lib/ip-assignment.js"),
		actions: await import("../app/admin/actions.js"),
		alerts: await import("../lib/alert-rules.js"),
		plans: await import("../lib/plans.js"),
		Account: (await import("../models/Account.js")).default,
		Alert: (await import("../models/Alert.js")).default,
		DedicatedIp: (await import("../models/DedicatedIp.js")).default,
	};
	provider = (await import("../lib/email-provider/index.js")).getEmailProvider();
	admin = await signIn("ops@example.com");
});

after(() => app?.stop());

const doc = (ip) => m.DedicatedIp.findOne({ ip }).lean();

async function payingAccount(email, { addon = false } = {}) {
	const user = await signIn(email);
	await activate(user, { plan: "pro" });
	if (addon) {
		await m.Account.updateOne(
			{ _id: user.accountId },
			{ $set: { "dedicatedIp.polarSubscriptionId": `sub_${email}`, "dedicatedIp.status": "active", "dedicatedIp.waitingAt": new Date() } }
		);
	}
	return user;
}

describe("the inventory", () => {
	test("an admin adds an IP AWS leased: it leaves SES's default pool for a parking one, and AWS has to list it", async () => {
		assert.match((await m.inventory.addIp({ ip: "not an ip" })).error, /isn't an IPv4 address/);
		assert.match((await m.inventory.addIp({ ip: "256.1.1.1" })).error, /isn't an IPv4/);
		assert.match((await m.inventory.addIp({ ip: "192.0.2.1" })).error, /AWS doesn't list 192.0.2.1: lease it first/);
		leaseIp("192.0.2.1");
		assert.equal(ses.dedicatedIps.get("192.0.2.1").poolName, "ses-default-dedicated-pool", "where AWS leaves a new IP");
		assert.deepEqual(await as(admin, () => m.actions.addIpAction(" 192.0.2.1 ", "first lease")), { ok: true, ip: "192.0.2.1", assigned: 0 });
		assert.equal(ses.dedicatedIps.get("192.0.2.1").poolName, m.inventory.PARKING_POOL, "parked: the default pool would carry every shared account's mail");
		assert.equal(ses.pools.has(m.inventory.PARKING_POOL), true);
		const stored = await doc("192.0.2.1");
		assert.deepEqual([stored.state, stored.poolName], ["available", m.inventory.PARKING_POOL]);
		assert.match(stored.notes, /first lease\. Added by ops@example.com/);
		assert.ok(stored.leasedAt);
		assert.match((await m.inventory.addIp({ ip: "192.0.2.1" })).error, /in the inventory already \(available\)/);
	});

	test("only an admin can add, import or retire", async () => {
		const customer = await signIn("ip-nobody@example.com");
		assert.equal(await as(customer, () => catchNotFound(m.actions.addIpAction("192.0.2.9"))), true);
		assert.equal(await as(customer, () => catchNotFound(m.actions.importIpsAction())), true);
		assert.equal(await as(customer, () => catchNotFound(m.actions.retireIpAction("192.0.2.1"))), true);
		assert.equal(await as(customer, () => catchNotFound(m.actions.convertManagedPoolsAction())), true);
	});

	test("importing takes in every IP AWS lists, and retires a free one AWS no longer lists", async () => {
		leaseIp("192.0.2.2");
		leaseIp("192.0.2.3");
		const result = await as(admin, () => m.actions.importIpsAction());
		assert.deepEqual([result.ok, result.added.toSorted(), result.retired, result.failed], [true, ["192.0.2.2", "192.0.2.3"], [], []]);
		assert.equal((await doc("192.0.2.3")).state, "available");
		relinquishIp("192.0.2.3");
		const again = await as(admin, () => m.actions.importIpsAction());
		assert.deepEqual([again.added, again.retired], [[], ["192.0.2.3"]]);
		assert.equal((await doc("192.0.2.3")).state, "retired");
		leaseIp("192.0.2.3");
		assert.deepEqual((await m.inventory.addIp({ ip: "192.0.2.3" })).ip, "192.0.2.3", "a retired IP comes back when AWS lists it again");
		assert.equal((await doc("192.0.2.3")).state, "available");
	});

	test("it counts what is free, in use and retired, and what the idle ones cost: $24.95 each", async () => {
		const inventory = await m.inventory.getInventory();
		assert.deepEqual(inventory.counts, { available: 3, warming: 0, assigned: 0, retired: 0 });
		assert.equal(inventory.idleMonthlyCost, 74.85);
		assert.equal(inventory.monthlyCost, 74.85);
		assert.equal(m.inventory.getIdleMonthlyCost(1), 24.95);
		assert.equal(m.inventory.getIdleMonthlyCost(0), 0);
	});

	test("an IP is retired only while free, and keeps costing until it is relinquished at AWS", async () => {
		assert.deepEqual(await as(admin, () => m.actions.retireIpAction("192.0.2.3")), { ok: true, ip: "192.0.2.3" });
		assert.equal((await doc("192.0.2.3")).state, "retired");
		assert.deepEqual((await m.inventory.getInventory()).counts, { available: 2, warming: 0, assigned: 0, retired: 1 });
		assert.deepEqual(await m.inventory.retireIp("192.0.2.77"), { error: "That IP isn't in the inventory" });
	});
});

describe("giving an IP to an account", () => {
	test("the admin's Assign an IP takes a free one; with none free it says so and changes nothing", async () => {
		await m.DedicatedIp.updateMany({ state: "available" }, { $set: { state: "retired" } });
		const user = await payingAccount("assign-none@example.com");
		const refused = await as(admin, () => m.actions.setDedicatedIp(String(user.accountId), true));
		assert.match(refused.error, /No IP is free in the inventory/);
		const current = await m.Account.findById(user.accountId).lean();
		assert.equal(current.ses?.dedicatedPool, undefined);
		assert.equal(current.dedicatedIp?.waitingAt, undefined, "an admin's try isn't a waiting purchase");
		assert.equal(ses.pools.has(`mc-ip-${user.accountId}`), false);
		await m.DedicatedIp.updateMany({ state: "retired" }, { $set: { state: "available" } });
	});

	test("an IP that was never used goes first; one returned goes to the next account, with its note", async () => {
		const first = await payingAccount("assign-first@example.com");
		const result = await as(admin, () => m.actions.setDedicatedIp(String(first.accountId), true));
		assert.equal(result.ok, true);
		assert.deepEqual(await as(admin, () => m.actions.setDedicatedIp(String(first.accountId), true)), { ok: true, ip: result.ip }, "twice is the same IP, set up once");
		const released = await as(admin, () => m.actions.setDedicatedIp(String(first.accountId), false));
		assert.deepEqual(released, { ok: true, ip: result.ip });
		assert.equal((await m.DedicatedIp.findOne({ ip: result.ip }).lean()).state, "available");
		const second = await payingAccount("assign-second@example.com");
		const next = await as(admin, () => m.actions.setDedicatedIp(String(second.accountId), true));
		assert.notEqual(next.ip, result.ip, "an IP nobody used comes before the one that was returned");
		const third = await payingAccount("assign-third@example.com");
		const other = await as(admin, () => m.actions.setDedicatedIp(String(third.accountId), true));
		assert.notEqual(other.ip, result.ip);
		const fourth = await payingAccount("assign-fourth@example.com");
		const last = await as(admin, () => m.actions.setDedicatedIp(String(fourth.accountId), true));
		assert.equal(last.ip, result.ip, "then the returned one");
		const stored = await m.DedicatedIp.findOne({ ip: result.ip }).lean();
		assert.match(stored.notes, /Returned by account/);
		assert.equal(String(stored.lastAccountId), String(first.accountId));
		assert.deepEqual((await m.inventory.getInventory()).counts, { available: 0, warming: 3, assigned: 0, retired: 0 });
	});

	test("two accounts asking at once never get the same IP", async () => {
		await m.DedicatedIp.updateMany({ state: "available" }, { $set: { state: "retired" } });
		leaseIp("192.0.2.50");
		await m.inventory.addIp({ ip: "192.0.2.50" });
		const [a, b] = await Promise.all([m.inventory.claimAvailableIp("a".repeat(24)), m.inventory.claimAvailableIp("b".repeat(24))]);
		assert.equal(Boolean(a) + Boolean(b), 1, "one IP, one winner");
	});

	test("an IP that AWS no longer lists is retired when it is about to be given, and the next one is used", async () => {
		leaseIp("192.0.2.51");
		await m.inventory.addIp({ ip: "192.0.2.51" });
		await m.DedicatedIp.updateOne({ ip: "192.0.2.50" }, { $set: { state: "retired" }, $unset: { accountId: 1 } });
		relinquishIp("192.0.2.51");
		leaseIp("192.0.2.52");
		await m.inventory.addIp({ ip: "192.0.2.52" });
		const user = await payingAccount("assign-gone@example.com");
		const result = await as(admin, () => m.actions.setDedicatedIp(String(user.accountId), true));
		assert.equal(result.ip, "192.0.2.52");
		assert.equal((await doc("192.0.2.51")).state, "retired");
	});
});

describe("alerts", () => {
	test("none free while someone has bought the add-on or is waiting is an admin alert that reaches Telegram", async () => {
		assert.equal(m.alerts.isTelegramAlert({ accountId: null, key: "ip-inventory:empty" }), true);
		assert.equal(m.alerts.isTelegramAlert({ accountId: null, key: "ip-inventory:waiting:abc" }), true);
		await m.DedicatedIp.updateMany({ state: "available" }, { $set: { state: "retired" } });
		await m.Account.updateMany({ "dedicatedIp.polarSubscriptionId": { $exists: true } }, { $unset: { dedicatedIp: 1 } });
		await m.Alert.deleteMany({});
		assert.deepEqual(await m.inventory.checkInventoryLevel(), { available: 0, waiting: 0, purchases: 0, isShort: false });
		assert.equal(await m.Alert.countDocuments({ key: "ip-inventory:empty" }), 0, "nobody bought: nothing to run out of");

		await payingAccount("alert-bought@example.com", { addon: false });
		const buyer = await payingAccount("alert-buyer@example.com", { addon: true });
		const level = await m.inventory.checkInventoryLevel();
		assert.deepEqual([level.available, level.waiting, level.purchases, level.isShort], [0, 1, 1, true]);
		const alert = await m.Alert.findOne({ key: "ip-inventory:empty" }).lean();
		assert.equal(alert.title, "A dedicated IP buyer is waiting for an IP");
		assert.ok(alert.lastSentAt);
		const sentBefore = alert.lastSentAt.getTime();
		await m.inventory.checkInventoryLevel();
		assert.equal((await m.Alert.findOne({ key: "ip-inventory:empty" }).lean()).lastSentAt.getTime(), sentBefore, "once a day, not every hour");

		await m.DedicatedIp.updateOne({ ip: "192.0.2.2" }, { $set: { state: "available" } });
		assert.equal((await m.inventory.checkInventoryLevel()).isShort, false, "one free is enough");
		await m.Account.updateOne({ _id: buyer.accountId }, { $unset: { dedicatedIp: 1 } });
	});
});

describe("the managed pools from before standard IPs", () => {
	async function managed(email) {
		const user = await payingAccount(email);
		const tenant = await provider.ensureTenant(await m.Account.findById(user.accountId).lean());
		const pool = `mc-${user.accountId}`;
		ses.pools.add(pool);
		ses.configurationSetPools.set(tenant.configurationSet, pool);
		await m.Account.updateOne({ _id: user.accountId }, { $set: { "ses.dedicatedPool": pool, "ses.dedicatedPoolAt": new Date(), "dedicatedIp.turnedOnAt": new Date() } });
		return { user, pool, tenant };
	}

	test("the admin page deletes them all, so none is left billing $15 a month", async () => {
		const one = await managed("managed-one@example.com");
		const two = await managed("managed-two@example.com");
		assert.equal((await m.assignment.findManagedPoolAccounts()).length, 2);
		const result = await as(admin, () => m.actions.convertManagedPoolsAction());
		assert.deepEqual([result.ok, result.converted, result.failed], [true, 2, []]);
		for (const { user, pool, tenant } of [one, two]) {
			assert.equal(ses.pools.has(pool), false);
			assert.equal(ses.configurationSetPools.has(tenant.configurationSet), false);
			const current = await m.Account.findById(user.accountId).lean();
			assert.deepEqual([current.ses.dedicatedPool, current.dedicatedIp?.turnedOnAt], [undefined, undefined]);
		}
		assert.deepEqual(await m.assignment.findManagedPoolAccounts(), []);
		assert.deepEqual(await as(admin, () => m.actions.convertManagedPoolsAction()), { ok: true, converted: 0, failed: [], assigned: 0 }, "safe to run again");
	});

	test("assigning an IP to an account that has one converts it, and a purge frees the IP and both configuration sets", async () => {
		await m.DedicatedIp.updateOne({ ip: "192.0.2.2" }, { $set: { state: "available" } });
		const { user, pool } = await managed("managed-assign@example.com");
		const result = await provider.setDedicatedIp(user.accountId, true);
		assert.equal(result.status, "assigned");
		assert.equal(ses.pools.has(pool), false, "the managed pool is gone");
		const current = await m.Account.findById(user.accountId).lean();
		assert.equal(current.ses.dedicatedPool, `mc-ip-${user.accountId}`);

		const sets = [current.ses.configurationSet, current.ses.dedicatedConfigurationSet];
		await provider.removeTenant(current);
		assert.equal(ses.pools.has(`mc-ip-${user.accountId}`), false);
		assert.equal((await doc(result.ip)).state, "available", "back in the inventory when the account is deleted");
		for (const set of sets) assert.equal(ses.configurationSets.has(set), false, set);
		assert.equal(ses.tenants.has(current.ses.tenantName), false);
	});
});

describe("what the pages say", () => {
	test("the billing card leads with the at-cost sentence and names no plan's price", async () => {
		const { default: CardDedicatedIp } = await import("../components/CardDedicatedIp.jsx");
		const base = { isOn: false, state: "off", address: null, warmup: null, available: true, price: 27, interval: "month", subscription: null };
		const html = (dedicatedIp, props) => renderToStaticMarkup(createElement(CardDedicatedIp, { dedicatedIp: { ...base, ...dedicatedIp }, ...props }));
		const text = (markup) => markup.replaceAll(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replaceAll(/\s+/g, " ");
		const offer = text(html({}));
		assert.match(offer, /At cost\. AWS charges us \$24\.95 a month for your own sending IP and card fees come to about \$1\.50; you pay \$27 a month, with no markup on top\. We make our money from your plan, not your IP\./);
		assert.match(offer, /warmed up over about 4 to 6 weeks \(your email goes through shared IPs until then\)/);
		assert.match(offer, /steady volume above about 100,000 emails a month/);
		assert.match(offer, /Add for \$27\/month/);
		assert.doesNotMatch(offer, /\$35|\$69|\$269|per plan|warmed up automatically|by AWS|a year/);

		assert.match(text(html({ state: "waiting", available: false, subscription: { status: "active" } })), /Your IP is being prepared, usually within 2 business days/);
		const warming = text(html({ isOn: true, state: "warming", address: "192.0.2.9", available: false, warmup: { day: 9, days: 30, share: 35, isDone: false, isHeld: false }, subscription: { status: "active" } }));
		assert.match(warming, /Warming up: day 9 of 30, 35% of your email goes through your IP\./);
		const held = text(html({ isOn: true, state: "warming", available: false, warmup: { day: 9, days: 30, share: 5.9, isDone: false, isHeld: true }, subscription: { status: "active" } }));
		assert.match(held, /5\.9% of your email.* Today is held/);
		assert.match(text(html({ isOn: true, state: "active", address: "192.0.2.9", available: false, warmup: { day: 30, days: 30, share: 100, isDone: true, isHeld: false }, subscription: { status: "active" } })), /Active: 192\.0\.2\.9\. All of your email goes through your IP/);
		assert.match(text(html({ isOn: true, state: "warming", available: false, warmup: { day: 3, days: 30, share: 2.6, isDone: false, isHeld: false }, subscription: { status: "active", cancelAt: "2026-12-01T00:00:00Z" } })), /until Dec 1, 2026, then back to shared IPs/);
	});

	test("the admin inventory shows the idle cost, and says the add-on only pays back the IPs in use", async () => {
		const { default: CardIpInventory } = await import("../components/CardIpInventory.jsx");
		const inventory = await m.inventory.getInventory();
		const markup = renderToStaticMarkup(createElement(CardIpInventory, { inventory: JSON.parse(JSON.stringify(inventory)), managedPools: 2, awsMonthlyCost: m.plans.DEDICATED_IP_AWS_MONTHLY_COST }));
		const text = markup.replaceAll(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replaceAll(/\s+/g, " ");
		assert.match(text, /Idle cost \$\d+(\.\d\d)? a month/);
		assert.match(text, /The add-on is at cost, so only IPs in use are paid back/);
		assert.match(text, /2 accounts have a managed IP pool.* \$15 a month/);
		assert.match(text, /Import from AWS/);
	});

	test("the support corpus, llms.txt and the Polar product say the same: at cost, $27, monthly, no per-plan prices", async () => {
		const corpus = (await import("../lib/marketing/support-corpus.js")).getPricingText();
		const llms = await import("../lib/docs/llms.js");
		const catalog = (await import("../lib/polar-catalog.js")).getCatalog().find(({ kind }) => kind === "addon").getBody();
		const line = corpus.split("\n").find((entry) => entry.startsWith("Dedicated IP add-on")) ?? corpus;
		assert.match(line, /At cost\. AWS charges us \$24\.95/);
		assert.match(line, /billed monthly, even next to a yearly plan/);
		assert.doesNotMatch(corpus, /warmed up automatically|\$69 a month on Scale|\$269/);
		assert.ok(catalog.description.startsWith(m.plans.DEDICATED_IP_AT_COST));
		assert.match(catalog.description, /4 to 6 weeks/);
		assert.match(llms.getLlmsIndex("https://app.example.com"), /a dedicated IP add-on on Pro and above at cost, \$27 a month with no markup/);
	});
});
