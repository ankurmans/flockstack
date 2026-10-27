import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { startTestApp } from "./helpers/app.mjs";
import { createSeller, installFakeStripe } from "./helpers/shop.mjs";
let app, m, fake, counter = 0;
before(async () => {
	app = await startTestApp(); fake = installFakeStripe();
	m = { groups: await import("../lib/group-subscriptions.js"), Group: (await import("../models/GroupSubscription.js")).default, Contact: (await import("../models/Contact.js")).default, Newsletter: (await import("../models/Newsletter.js")).default };
});
after(() => app?.stop());
async function seller() {
	const user = await createSeller(`group-seller${++counter}@example.com`, { fake });
	await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { paidTier: { enabled: true, currency: "usd", trialDays: 14 }, paidTiers: [{ id: "basic", name: "Basic", prices: { month: 800, quarter: 2000, year: 8000, lifetime: 40000 }, pwyw: { enabled: true, minCents: 1000, interval: "year" } }, { id: "founder", name: "Founder", prices: { year: 12000 }, founding: { enabled: true, cap: 10 } }] } });
	user.newsletter = await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
	return user;
}
const input = extra => ({ tierId: "basic", option: "month", seats: 3, email: "group-buyer@example.com", externalId: randomUUID(), ...extra });
const checkout = (user, data) => m.groups.createGroupCheckout({ account: user.account, newsletter: user.newsletter, input: data });
async function enable(user) {
	await m.groups.saveGroupSettings(user.account, user.newsletter, true);
	user.newsletter = await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
}

test("group plans use fixed recurring creator prices and remain off until explicitly enabled", async () => {
	const user = await seller();
	assert.equal(m.groups.groupSettings(user.account, user.newsletter).enabled, false);
	assert.deepEqual(m.groups.groupPlans(user.newsletter).map(plan => plan.option), ["month", "quarter", "year"]);
	assert.ok(m.groups.groupPlans(user.newsletter).every(plan => plan.tierId === "basic"));
	await assert.rejects(checkout(user, input()), error => error.code === "conflict");
});

test("group checkout has one licensed quantity, no individual trial and no automatic subscriber enrollment", async () => {
	const user = await seller(); await enable(user);
	const count = await m.Contact.countDocuments({ accountId: user.accountId });
	const result = await checkout(user, input());
	assert.match(result.checkoutUrl, /^https:\/\/checkout\.stripe\.test\//);
	const group = await m.groups.findGroup(user.account, result.id);
	assert.equal(group.capacity, 0); assert.equal(group.status, "checkout"); assert.equal(group.requestedSeats, 3); assert.ok(group.priceId);
	const session = [...fake.sessions.values()].find(session => session.metadata?.groupId === result.id);
	assert.equal(Number(session.line_items[0].quantity), 3); assert.equal(session.line_items[0].price, group.priceId);
	assert.equal(session.subscription_data.trial_period_days, undefined); assert.equal(session.customer, undefined);
	assert.equal(session.metadata.kind, "group_subscription"); assert.equal(session.subscription_data.metadata.groupId, result.id);
	assert.ok(session.success_url.includes(`/groups/complete?session_id=`)); assert.equal(new URL(session.cancel_url).pathname, "/reader/groups/buy"); assert.equal(new URL(session.cancel_url).searchParams.get("newsletter"), user.slug); assert.doesNotMatch(session.success_url, /undefined|group-buyer/);
	assert.equal(await m.Contact.countDocuments({ accountId: user.accountId }), count);
	assert.ok(!JSON.stringify(session).includes("application_fee"));
});

test("concurrent checkout retries recover one group/session and refuse changed buyer or quantity", async () => {
	const user = await seller(); await enable(user); const data = input();
	const [one, two] = await Promise.all([checkout(user, data), checkout(user, data)]);
	assert.deepEqual(one, two);
	assert.equal(await m.Group.countDocuments({ accountId: user.accountId, externalId: data.externalId }), 1);
	assert.equal([...fake.sessions.values()].filter(session => session.metadata?.groupId === one.id).length, 1);
	assert.deepEqual(await checkout(user, data), one);
	await assert.rejects(checkout(user, { ...data, email: "someone-else@example.com" }), error => error.code === "conflict");
	await assert.rejects(checkout(user, { ...data, seats: 4 }), error => error.code === "conflict");
	const other = await seller();
	await assert.rejects(m.groups.findGroup(other.account, one.id), error => error.code === "not_found");
});

test("unsupported quantities, modes and retry identifiers are refused before a provider checkout", async () => {
	const user = await seller(); await enable(user);
	for (const extra of [{ seats: 1 }, { seats: 101 }, { seats: 2.5 }, { option: "lifetime" }, { option: "pwyw" }, { tierId: "founder", option: "year" }, { externalId: "------------------------------------" }]) await assert.rejects(checkout(user, input(extra)), error => error.code === "validation_failed");
	assert.equal(await m.Group.countDocuments({ accountId: user.accountId }), 0);
});
