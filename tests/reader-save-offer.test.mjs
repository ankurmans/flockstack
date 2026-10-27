import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { mockStripe, startTestApp } from "./helpers/app.mjs";
import { installFakeStripe } from "./helpers/shop.mjs";
import { retentionModels, retentionReader } from "./helpers/reader-retention.mjs";
let app, m, fake, counter = 0;
before(async () => { app = await startTestApp(); fake = installFakeStripe(); m = { ...(await retentionModels()), save: await import("../lib/reader-save-offer.js"), offers: await import("../lib/offers.js"), contacts: await import("../lib/contacts.js"), Offer: (await import("../models/Offer.js")).default }; });
after(() => app?.stop());
async function offeredReader(extra = {}) {
	const s = await retentionReader(m, fake, extra);
	let offer = await m.Offer.create({ accountId: s.user.accountId, newsletterId: s.newsletter._id, name: "Stay for less", code: `stay-${++counter}`, type: "percent", percentOff: 20, duration: "repeating", durationMonths: 3, active: true });
	const id = await m.offers.createCoupon({ account: s.user.account, offer });
	offer = await m.Offer.findOneAndUpdate({ accountId: s.user.accountId, _id: offer._id }, { $set: { stripeCouponId: id } }, { new: true }).lean();
	await m.Newsletter.updateOne({ accountId: s.user.accountId, _id: s.newsletter._id }, { $set: { "readerRetention.saveOfferId": offer._id } });
	const context = await m.store.readCurrentReaderBilling(s.target), choice = await m.save.readReaderSaveOffer(context);
	return { ...s, offer, choice, input: { ...s.target, externalId: randomUUID(), offerId: String(offer._id), expectedHash: choice.offer?.hash, confirm: true } };
}
test("a creator-selected save coupon applies once without changing price, charging or replacing signup history", async () => {
	const s = await offeredReader({ cancel_at_period_end: true }); assert.equal(s.choice.available, true);
	s.subscription.metadata.offerId = "original-signup-offer";
	const start = fake.requests.length, result = await m.save.acceptReaderSaveOffer(s.input);
	assert.equal(result.record.saveOfferId.toString(), String(s.offer._id)); assert.equal(result.context.subscription.cancel_at_period_end, false); assert.equal(s.subscription.metadata.offerId, "original-signup-offer");
	assert.equal(s.subscription.items.data[0].price.unit_amount, 1000); assert.equal(fake.coupons.get(s.offer.stripeCouponId).times_redeemed, 1);
	const writes = fake.requests.slice(start).filter(request => request.method !== "GET"); assert.equal(writes.length, 1); assert.equal(writes[0].path, `/v1/subscriptions/${s.subscription.id}`); assert.equal(writes[0].params.proration_behavior, "none"); assert.equal(writes[0].apiVersion, "2026-09-30.endive");
	assert.equal((await m.save.acceptReaderSaveOffer(s.input)).duplicate, true);
	await assert.rejects(m.save.acceptReaderSaveOffer({ ...s.input, externalId: randomUUID() }), /already/);
});
test("the save flow refuses unconfirmed or changed offers, existing discounts, invalid provider facts and schedules", async () => {
	const s = await offeredReader();
	await assert.rejects(m.save.acceptReaderSaveOffer({ ...s.input, confirm: false }), /Confirm the creator/);
	await assert.rejects(m.save.acceptReaderSaveOffer({ ...s.input, expectedHash: "0".repeat(64) }), /offer changed/);
	s.subscription.discounts = [{ id: "di_existing", source: { coupon: "coupon_existing" } }];
	const start = fake.requests.length; await assert.rejects(m.save.acceptReaderSaveOffer(s.input), /already has a discount/); assert.equal(fake.requests.slice(start).some(request => request.method !== "GET"), false);
	s.subscription.discounts = []; s.subscription.items.data[0].discounts = ["di_item"]; await assert.rejects(m.save.acceptReaderSaveOffer(s.input), /already has a discount/);
	s.subscription.items.data[0].discounts = []; s.subscription.schedule = "sub_sched_other"; await assert.rejects(m.save.acceptReaderSaveOffer(s.input), /schedule/);
	s.subscription.schedule = null; fake.coupons.get(s.offer.stripeCouponId).percent_off = 25; await assert.rejects(m.save.acceptReaderSaveOffer(s.input), /hasn't confirmed/);
});
test("an unknown save response confirms the actual coupon on retry without applying it twice", async () => {
	const s = await offeredReader(), handler = fake.handler; let lose = true;
	mockStripe(async request => { const answer = await handler(request); if (lose && request.method === "POST" && request.path === `/v1/subscriptions/${s.subscription.id}`) { lose = false; throw new DOMException("Unknown response", "TimeoutError"); } return answer; });
	try { await assert.rejects(m.save.acceptReaderSaveOffer(s.input), error => error.code === "unavailable"); } finally { mockStripe(handler); }
	const result = await m.save.acceptReaderSaveOffer(s.input); assert.ok(result.record.saveUsedAt); assert.equal(fake.coupons.get(s.offer.stripeCouponId).times_redeemed, 1);
	assert.equal(fake.requests.filter(request => request.method === "POST" && request.path === `/v1/subscriptions/${s.subscription.id}`).length, 1);
});
test("deleting a reader removes survey content but cannot reset the subscription's once-only save history", async () => {
	const s = await offeredReader(), saved = await m.save.acceptReaderSaveOffer(s.input);
	await m.Response.create({ accountId: s.user.accountId, newsletterId: s.newsletter._id, contactId: s.contact._id, retentionId: saved.record._id, externalId: randomUUID(), reason: "cost", comment: "Private response", sharedAt: new Date() });
	const current = await m.Contact.findOne({ accountId: s.user.accountId, _id: s.contact._id }).lean(); await m.contacts.removeContact(s.user.account, current);
	const record = await m.Retention.findOne({ accountId: s.user.accountId, _id: saved.record._id }).lean(); assert.equal(record.contactId, undefined); assert.ok(record.saveUsedAt); assert.equal(await m.Response.countDocuments({ accountId: s.user.accountId, retentionId: record._id }), 0);
	s.subscription.discounts = [];
	const replacement = await m.Contact.create({ accountId: s.user.accountId, newsletterId: s.newsletter._id, email: s.customer.email, status: "active", stripeCustomerId: s.customer.id, stripeSubscriptionId: s.subscription.id, paidPersonal: current.paidPersonal, tier: "paid", paidUntil: current.paidUntil });
	const context = await m.store.readCurrentReaderBilling({ ...s.target, contactId: replacement._id }); const choice = await m.save.readReaderSaveOffer(context); assert.equal(choice.available, false); assert.match(choice.problem, /already used/);
});
