import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { startTestApp } from "./helpers/app.mjs";
import { createSeller, installFakeStripe } from "./helpers/shop.mjs";
import { shiftDateKey, toDateKey } from "../lib/time-zone.js";
let app, m, fake, count = 0;
before(async () => {
	app = await startTestApp(); fake = installFakeStripe();
	m = { inventory: await import("../lib/sponsorship-inventory.js"), Placement: (await import("../models/SponsorshipPlacement.js")).default, Slot: (await import("../models/SponsorshipSlot.js")).default, Booking: (await import("../models/SponsorshipBooking.js")).default, Newsletter: (await import("../models/Newsletter.js")).default, Campaign: (await import("../models/Campaign.js")).default };
});
after(() => app?.stop());
async function setup() {
	const user = await createSeller(`sponsor-inventory${++count}@example.com`, { fake });
	const newsletter = await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
	const placement = await m.inventory.saveSponsorshipPlacement({ account: user.account, newsletter, input: { name: "Main sponsor", description: "One clearly labeled email placement", amountMinor: 25000, currency: "usd" } });
	const input = { placementId: String(placement._id), day: shiftDateKey(toDateKey(new Date(), "UTC"), 7), timeZone: "UTC" };
	const save = extra => m.inventory.saveSponsorshipSlot({ account: user.account, newsletter, input: { ...input, ...extra } });
	const slot = await save();
	return { user, newsletter, placement, slot, save };
}
async function request(s, email) {
	return m.Booking.create({ accountId: s.user.accountId, newsletterId: s.user.newsletterId, slotId: s.slot._id, placementId: s.placement._id, placementName: s.placement.name, day: s.slot.day, timeZone: s.slot.timeZone, amountMinor: s.slot.amountMinor, currency: s.slot.currency, email, brandName: "Example sponsor", status: "requested", verifiedAt: new Date(), externalId: randomUUID() });
}
const accept = (s, booking) => m.inventory.acceptSponsorshipBooking({ account: s.user.account, bookingId: booking._id });

test("repeated availability writes keep one scoped placement/day and do not create a scheduled campaign", async () => {
	const s = await setup(), before = await m.Campaign.countDocuments({ accountId: s.user.accountId });
	const [one, two] = await Promise.all([s.save(), s.save()]);
	assert.equal(String(one._id), String(two._id)); assert.equal(await m.Slot.countDocuments({ accountId: s.user.accountId }), 1);
	assert.equal(await m.Campaign.countDocuments({ accountId: s.user.accountId }), before);
	assert.equal((await s.save({ open: false })).status, "closed"); assert.equal((await s.save()).status, "open");
});

test("two verified sponsorship requests cannot reserve the same date twice", async () => {
	const s = await setup(), first = await request(s, "first-sponsor@example.com"), second = await request(s, "second-sponsor@example.com");
	const results = await Promise.allSettled([accept(s, first), accept(s, second)]);
	assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
	const slot = await m.Slot.findOne({ accountId: s.user.accountId, _id: s.slot._id }).lean();
	assert.equal(slot.status, "reserved"); assert.equal(await m.Booking.countDocuments({ accountId: s.user.accountId, status: "accepted" }), 1);
	const winner = String(slot.bookingId) === String(first._id) ? first : second;
	assert.equal((await accept(s, winner)).status, "accepted");
	await assert.rejects(s.save({ amountMinor: 30000 }), error => error.code === "conflict");
	assert.equal(fake.requests.filter(request => ["/v1/invoices", "/v1/checkout/sessions"].includes(request.path)).length, 0);
});

test("changed quotes and unverified addresses cannot reserve inventory", async () => {
	const s = await setup(), booking = await request(s, "quote@example.com");
	await s.save({ amountMinor: 30000 });
	await assert.rejects(accept(s, booking), error => error.code === "conflict");
	assert.equal((await m.Slot.findOne({ accountId: s.user.accountId, _id: s.slot._id }).lean()).status, "open");
	await s.save({ amountMinor: 25000 });
	await m.Booking.updateOne({ accountId: s.user.accountId, _id: booking._id }, { $unset: { verifiedAt: 1 } });
	await assert.rejects(accept(s, booking), error => error.code === "conflict");
});

test("a reserved date recovers its interrupted booking transition and rejects another account", async () => {
	const s = await setup(), booking = await request(s, "recover@example.com");
	await m.Slot.updateOne({ accountId: s.user.accountId, _id: s.slot._id }, { $set: { status: "reserved", bookingId: booking._id }, $inc: { revision: 1 } });
	assert.equal((await accept(s, booking)).status, "accepted");
	const other = await setup();
	await assert.rejects(m.inventory.acceptSponsorshipBooking({ account: other.user.account, bookingId: booking._id }), error => error.code === "not_found");
	await assert.rejects(m.inventory.saveSponsorshipSlot({ account: other.user.account, newsletter: s.newsletter, input: { placementId: String(s.placement._id), day: s.slot.day, timeZone: "UTC" } }), error => error.code === "not_found");
});
