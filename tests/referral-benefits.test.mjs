import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { anonymous, startTestApp } from "./helpers/app.mjs";
import { api, createSeller } from "./helpers/shop.mjs";

let app;
let m;
let n = 0;
before(async () => {
	app = await startTestApp();
	m = {
		Newsletter: (await import("../models/Newsletter.js")).default,
		Contact: (await import("../models/Contact.js")).default,
		Delivery: (await import("../models/WebhookDelivery.js")).default,
		Code: (await import("../models/ReferralCode.js")).default,
		Reward: (await import("../models/ReferralReward.js")).default,
		Gift: (await import("../models/Gift.js")).default,
		referrals: await import("../lib/referrals.js"),
		benefits: await import("../lib/referral-benefits.js"),
		gifts: await import("../lib/gifts.js"),
		rules: await import("../lib/gift-rules.js"),
		contacts: await import("../lib/contacts.js"),
		TooltipProvider: (await import("../components/ui/tooltip.jsx")).TooltipProvider,
		page: (await import("../app/referral/page.js")).default,
		links: await import("../lib/referral-links.js"),
	};
});
after(() => app?.stop());

async function program(rewards = [{ kind: "code", referrals: 1, title: "Your own code" }]) {
	const user = await createSeller(`benefit${++n}@example.com`, { ready: false, requireConfirmation: true });
	await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { fromEmail: "writer@example.com", paidTier: { enabled: true }, paidTiers: [{ id: "supporter", name: "Supporter", prices: { month: 500 } }] } });
	const result = await api(user, "PATCH", "/referrals/settings", { newsletter: user.slug, enabled: true, rewards });
	assert.equal(result.status, 200, JSON.stringify(result.body));
	user.reward = result.body.rewards[0];
	user.newsletter = await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
	return user;
}
async function reader(user, extra = {}) {
	return m.Contact.create({ accountId: user.accountId, newsletterId: user.newsletterId, email: `reader${++n}@example.com`, status: "active", referral: { count: 1 }, ...extra });
}
const unlock = (user, contact) => m.referrals.unlockRewards({ newsletter: user.newsletter, referrer: contact, count: contact.referral.count });
const addCodes = (user, codes, rewardId = user.reward.id) => api(user, "POST", "/referrals/codes", { newsletter: user.slug, rewardId, codes });
const retry = (user, cursor) => api(user, "POST", "/referrals/fulfill", { newsletter: user.slug, ...(cursor && { cursor }) });
const status = (user, contact) => m.referrals.getReaderReferralStatus({ newsletter: user.newsletter, contact });
const tokenOf = (url) => new URL(url).searchParams.get("token");

test("exact stock is private, deduplicated across rewards and supplied without fulfillment", async () => {
	const user = await program([{ kind: "code", referrals: 1, title: "First" }, { kind: "code", referrals: 2, title: "Second" }]);
	assert.deepEqual((await addCodes(user, ["Exact-A", "exact-a", "Exact-A"])).body, { added: 2, duplicates: 1 });
	assert.deepEqual((await addCodes(user, ["Exact-A"], user.newsletter.referral.rewards[1].id)).body, { added: 0, duplicates: 1 });
	assert.equal((await addCodes(user, [" spaces "])).status, 400);
	assert.equal((await addCodes(user, ["line\nbreak"])).status, 400);
	const response = await api(user, "GET", `/referrals/settings?newsletter=${user.slug}`);
	assert.deepEqual(response.body.stock, [{ rewardId: user.reward.id, available: 2, assigned: 0, pending: 0 }]);
	assert.ok(!JSON.stringify(response.body).includes("Exact-A"));
	assert.equal(await m.Reward.countDocuments({ accountId: user.accountId }), 0);
});

test("concurrent unlocks assign one code per receipt, and stock exhaustion stays pending", async () => {
	const user = await program();
	await addCodes(user, ["Once-A", "Once-B", "Once-C"]);
	const contacts = await Promise.all(Array.from({ length: 5 }, () => reader(user)));
	await Promise.all(contacts.flatMap((contact) => [unlock(user, contact), unlock(user, contact)]));
	assert.equal(await m.Reward.countDocuments({ accountId: user.accountId }), 5);
	const assigned = await m.Code.find({ accountId: user.accountId, receiptId: { $exists: true } }).lean();
	assert.equal(assigned.length, 3);
	assert.equal(new Set(assigned.map((c) => String(c.receiptId))).size, 3);
	const rows = await Promise.all(contacts.map((contact) => status(user, contact)));
	assert.equal(rows.filter((r) => r.rewards[0].code).length, 3);
	assert.equal(rows.filter((r) => !r.rewards[0].isReady).length, 2);
	assert.equal(new Set(rows.map((r) => r.rewards[0].code).filter(Boolean)).size, 3);
	const pending = contacts.find((_, index) => !rows[index].rewards[0].isReady);
	await addCodes(user, ["Restocked-A", "Restocked-B"]);
	assert.equal((await status(user, pending)).rewards[0].isReady, false, "a read never spends inventory");
	assert.equal((await retry(user)).body.ready, 2);
	assert.equal((await retry(user)).body.checked, 0);
	const all = await Promise.all(contacts.map((contact) => status(user, contact)));
	assert.equal(new Set(all.map((r) => r.rewards[0].code)).size, 5);
});

test("allocation recovers a crash after assigning a code, without using another code", async () => {
	const user = await program();
	await addCodes(user, ["Recover-A", "Recover-B"]);
	const contact = await reader(user);
	const original = m.Reward.updateOne;
	m.Reward.updateOne = (...args) => { if (args[1]?.$set?.state === "ready") throw new Error("simulated receipt failure"); return original(...args); };
	try { await assert.rejects(unlock(user, contact), /simulated receipt failure/); }
	finally { m.Reward.updateOne = original; }
	assert.equal((await retry(user)).body.ready, 1);
	assert.equal((await status(user, contact)).rewards[0].code, "Recover-A");
	assert.equal(await m.Code.countDocuments({ accountId: user.accountId, receiptId: { $exists: true } }), 1);
});

test("earned benefit is frozen, scoped to its reader, and survives disabling or removing the reward", async () => {
	const user = await program();
	const foreign = await program();
	const contact = await reader(user);
	await addCodes(user, ["Only-Mine"]);
	await unlock(user, contact);
	const changed = await api(user, "PATCH", "/referrals/settings", { newsletter: user.slug, rewards: [{ ...user.reward, kind: "gift", tierId: "supporter", months: 1 }] });
	assert.equal(changed.status, 409);
	assert.equal((await api(foreign, "POST", "/referrals/codes", { newsletter: user.slug, rewardId: user.reward.id, codes: ["Foreign"] })).status, 404);
	const page = async (token) => renderToStaticMarkup(createElement(m.TooltipProvider, null, await anonymous(() => m.page({ searchParams: Promise.resolve({ token }) }))));
	const token = m.links.createReferralPageToken({ contactId: contact._id, newsletterId: user.newsletterId });
	assert.match(await page(token), /Only-Mine/);
	assert.ok(!(await page(`${token}x`)).includes("Only-Mine"));
	await api(user, "PATCH", "/referrals/settings", { newsletter: user.slug, enabled: false, rewards: [] });
	user.newsletter = await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
	assert.match(await page(token), /Only-Mine/);
	const other = await reader(user);
	assert.ok(!JSON.stringify(await status(user, other)).includes("Only-Mine"));
	await m.Contact.updateOne({ accountId: user.accountId, _id: contact._id }, { $set: { status: "unsubscribed" } });
	assert.ok(!(await page(token)).includes("Only-Mine"));
});

test("fulfillment is bounded, skips inactive readers, and gift creation retries use one zero-price gift", async () => {
	const user = await program([{ kind: "gift", referrals: 1, title: "Three months", tierId: "supporter", months: 3 }]);
	const contact = await reader(user);
	await Promise.all([unlock(user, contact), unlock(user, contact)]);
	assert.equal(await m.Gift.countDocuments({ accountId: user.accountId }), 1);
	const gift = await m.Gift.findOne({ accountId: user.accountId }).lean();
	assert.equal(gift.amountCents, 0); assert.equal(gift.stripeSessionId, undefined);
	assert.equal(gift.recipientEmail, contact.email);
	const reward = (await status(user, contact)).rewards[0];
	assert.ok(reward.giftUrl); assert.equal(reward.code, null);
	const first = await m.gifts.redeemGift(tokenOf(reward.giftUrl));
	assert.equal(first.ok, true);
	assert.equal((await m.gifts.redeemGift(tokenOf(reward.giftUrl))).until, first.until);
	const current = await m.Contact.findOne({ accountId: user.accountId, _id: contact._id }).lean();
	assert.equal(current.giftReceipts[String(gift._id)], first.until);
	assert.equal(current.tier, "paid");
	assert.equal(current.stripeSubscriptionId, undefined);
	const records = await Promise.all(Array.from({ length: 27 }, async (_, i) => {
		const c = await reader(user, { status: i === 0 ? "unsubscribed" : "active" });
		return m.Reward.create({ accountId: user.accountId, newsletterId: user.newsletterId, contactId: c._id, rewardId: user.reward.id, referrals: 1, benefit: user.reward, state: "pending" });
	}));
	const batch = (await retry(user)).body;
	assert.equal(batch.checked, 25); assert.equal(batch.ready, 24); assert.ok(batch.nextCursor);
	assert.equal((await retry(user, batch.nextCursor)).body.ready, 2);
	assert.equal(await m.Gift.countDocuments({ accountId: user.accountId }), 27);
	assert.equal((await m.Reward.findOne({ accountId: user.accountId, _id: records[0]._id }).lean()).state, "pending");
});

test("gift redemption recovers a failed final write, and concurrent gifts extend access additively", async () => {
	const user = await program([{ kind: "gift", referrals: 1, title: "One month", tierId: "supporter", months: 1 }]);
	const contact = await reader(user);
	await unlock(user, contact);
	const gift = await m.Gift.findOne({ accountId: user.accountId }).lean();
	const token = tokenOf(m.gifts.getGiftRedeemUrl(gift, user.newsletter));
	const original = m.Gift.updateOne;
	m.Gift.updateOne = (...args) => { if (args[1]?.$set?.accessUntil) throw new Error("simulated final failure"); return original(...args); };
	try { await assert.rejects(m.gifts.redeemGift(token), /simulated final failure/); }
	finally { m.Gift.updateOne = original; }
	const after = await m.Contact.findOne({ accountId: user.accountId, _id: contact._id }).lean();
	const until = after.giftReceipts[String(gift._id)];
	assert.equal((await m.gifts.redeemGift(token)).until, until);
	const gifts = await Promise.all([1, 2].map(() => m.Gift.create({ accountId: user.accountId, newsletterId: user.newsletterId, tierId: "supporter", months: 1, amountCents: 0, currency: "usd", buyerEmail: "writer@example.com", recipientEmail: contact.email, deliverOn: new Date(), expiresAt: m.rules.addMonths(new Date(), 12), status: "sent" })));
	const answers = await Promise.all(gifts.map((g) => m.gifts.redeemGift(tokenOf(m.gifts.getGiftRedeemUrl(g, user.newsletter)))));
	assert.ok(answers.every((a) => a.ok), JSON.stringify(answers));
	const final = await m.Contact.findOne({ accountId: user.accountId, _id: contact._id }).lean();
	assert.equal(new Date(final.grant.until).toISOString(), m.rules.addMonths(m.rules.addMonths(new Date(until), 1), 1).toISOString());
	assert.equal(Object.keys(final.giftReceipts).length, 3);
});

test("contact deletion removes reward identity but never returns its code to stock", async () => {
	const user = await program();
	await addCodes(user, ["Never-Reissue"]);
	const contact = await reader(user);
	await unlock(user, contact);
	assert.equal(await m.contacts.removeContact({ _id: user.accountId }, contact), true);
	assert.equal(await m.Reward.countDocuments({ accountId: user.accountId, contactId: contact._id }), 0);
	const inventory = await m.Code.findOne({ accountId: user.accountId }).lean();
	assert.ok(inventory.receiptId); assert.equal(inventory.contactId, undefined);
	assert.equal((await addCodes(user, ["Never-Reissue"])).body.added, 0);
	const second = await reader(user); await unlock(user, second);
	assert.equal((await status(user, second)).rewards[0].isReady, false);
});

test("month additions clamp the last day, including leap years", () => {
	assert.equal(m.rules.addMonths(new Date("2027-01-31T12:34:00Z"), 1).toISOString(), "2027-02-28T12:34:00.000Z");
	assert.equal(m.rules.addMonths(new Date("2028-01-31T12:34:00Z"), 1).toISOString(), "2028-02-29T12:34:00.000Z");
	assert.equal(m.rules.addMonths(new Date("2028-02-29T12:34:00Z"), 12).toISOString(), "2029-02-28T12:34:00.000Z");
});

test("new receipt events emit once and contain only identifiers", async () => {
	const user = await program();
	const endpoint = await api(user, "POST", "/webhooks", { url: "https://hooks.example.com/flockstack", events: ["referral_reward.earned", "referral_reward.fulfilled"] });
	assert.equal(endpoint.status, 201, JSON.stringify(endpoint.body));
	await addCodes(user, ["PRIVATE_NOT_WEBHOOK"]);
	const contact = await reader(user);
	await Promise.all([unlock(user, contact), unlock(user, contact)]);
	const deliveries = await m.Delivery.find({ accountId: user.accountId }).lean();
	assert.equal(deliveries.length, 2);
	assert.deepEqual(deliveries.map((r) => r.type).sort(), ["referral_reward.earned", "referral_reward.fulfilled"]);
	for (const delivery of deliveries) {
		const payload = typeof delivery.payload === "string" ? JSON.parse(delivery.payload) : delivery.payload;
		assert.deepEqual(Object.keys(payload.data).sort(), ["id", "newsletterId", "rewardId"]);
		assert.ok(!JSON.stringify(payload).includes("PRIVATE_NOT_WEBHOOK"));
	}
});

test("gift rewards preserve an existing recurring subscription and lifetime access", async () => {
	const user = await program([{ kind: "gift", referrals: 1, title: "Access", tierId: "supporter", months: 1 }]);
	for (const interval of ["month", "lifetime"]) {
		const paidUntil = new Date(interval === "month" ? Date.now() + 30 * 86400000 : "9999-12-31T00:00:00Z");
		const contact = await reader(user, { tier: "paid", paidTierId: "supporter", paidInterval: interval, paidUntil, subscriptionStatus: interval === "month" ? "active" : undefined, stripeSubscriptionId: interval === "month" ? "sub_synthetic_unchanged" : undefined });
		await unlock(user, contact);
		const giftUrl = (await status(user, contact)).rewards[0].giftUrl;
		assert.equal((await m.gifts.redeemGift(tokenOf(giftUrl))).ok, true);
		const current = await m.Contact.findOne({ accountId: user.accountId, _id: contact._id }).lean();
		assert.equal(new Date(current.paidUntil).toISOString(), paidUntil.toISOString());
		assert.equal(current.paidInterval, interval);
		assert.equal(current.stripeSubscriptionId, contact.stripeSubscriptionId);
	}
});

test("complimentary referral gifts preserve the newsletter currency in their zero-price metadata", async () => {
	const user = await program([{ kind: "gift", referrals: 1, title: "A month", tierId: "supporter", months: 1 }]);
	await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { "paidTier.currency": "eur" } });
	user.newsletter = await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
	const contact = await reader(user); await unlock(user, contact);
	const gift = await m.Gift.findOne({ accountId: user.accountId }).lean();
	assert.equal(gift.currency, "eur"); assert.equal(gift.amountCents, 0);
});
