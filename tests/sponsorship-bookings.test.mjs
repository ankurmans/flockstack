import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startTestApp } from "./helpers/app.mjs";
import { installFakeStripe } from "./helpers/shop.mjs";
import { sponsorCreative, sponsorRequest, sponsorshipModels, sponsorshipSeller } from "./helpers/sponsorships.mjs";
let app, m, fake;
before(async () => { app = await startTestApp(); fake = installFakeStripe(); m = await sponsorshipModels(); });
after(() => app?.stop());

test("sponsorship requests email verification without enrolling anyone, reserving inventory or creating an invoice", async () => {
	const s = await sponsorshipSeller(m, fake), created = await sponsorRequest(m, s);
	assert.equal(created.result.verificationSent, true); assert.equal(created.result.status, "unverified");
	assert.doesNotMatch(JSON.stringify(created.result), /token|managerUrl|email|brandName/);
	assert.equal(await m.Contact.countDocuments({ accountId: s.user.accountId }), 0);
	assert.equal((await m.Slot.findOne({ accountId: s.user.accountId, _id: s.slot._id }).lean()).status, "open");
	await assert.rejects(m.inventory.acceptSponsorshipBooking({ account: s.user.account, bookingId: created.booking._id }), error => error.code === "conflict");
	assert.equal(fake.requests.filter(request => request.method === "POST" && ["/v1/invoices", "/v1/checkout/sessions", "/v1/customers"].includes(request.path)).length, 0);
});

test("stable request retries reuse one booking and refuse a different advertiser or slot", async () => {
	const s = await sponsorshipSeller(m, fake), created = await sponsorRequest(m, s);
	const again = await m.bookings.requestSponsorship({ account: s.user.account, newsletter: s.newsletter, input: created.input });
	assert.equal(again.id, created.result.id); assert.equal(again.verificationSent, false); assert.equal(await m.Booking.countDocuments({ accountId: s.user.accountId }), 1);
	await assert.rejects(m.bookings.requestSponsorship({ account: s.user.account, newsletter: s.newsletter, input: { ...created.input, email: "another@example.com" } }), error => error.code === "conflict");
});

test("only a verification capability can confirm the request, and management stays available when the archive closes", async () => {
	const s = await sponsorshipSeller(m, fake), created = await sponsorRequest(m, s);
	await assert.rejects(m.bookings.readSponsorshipContext(created.token, "manager"), error => error.code === "not_found");
	const verified = await m.bookings.verifySponsorshipRequest(created.token);
	assert.equal(verified.booking.status, "requested"); assert.ok(verified.booking.verifiedAt);
	const manager = new URL(verified.managerUrl).searchParams.get("token");
	await assert.rejects(m.bookings.verifySponsorshipRequest(created.token), error => error.code === "not_found");
	await m.Newsletter.updateOne({ accountId: s.user.accountId, _id: s.newsletter._id }, { $set: { archiveEnabled: false, "sponsorships.enabled": false } });
	assert.equal(String((await m.bookings.readSponsorshipContext(manager)).booking._id), String(created.booking._id));
	assert.equal(await m.Contact.countDocuments({ accountId: s.user.accountId }), 0);
	await m.bookings.sendSponsorshipManagerEmail({ account: s.user.account, bookingId: created.booking._id, rotate: true });
	await assert.rejects(m.bookings.readSponsorshipContext(manager), error => error.code === "not_found");
});

test("only the owner approves the current creative hash and advertiser edits take that approval back", async () => {
	const s = await sponsorshipSeller(m, fake), created = await sponsorRequest(m, s);
	await m.bookings.verifySponsorshipRequest(created.token);
	const saved = await m.bookings.updateSponsorshipCreative({ account: s.user.account, bookingId: created.booking._id, input: sponsorCreative });
	await assert.rejects(m.bookings.approveSponsorshipCreative({ account: s.user.account, bookingId: saved._id, expectedHash: saved.creativeHash, actorId: "another-owner" }), error => error.code === "forbidden");
	const approved = await m.bookings.approveSponsorshipCreative({ account: s.user.account, bookingId: saved._id, expectedHash: saved.creativeHash, actorId: String(s.user.account.ownerId) });
	assert.equal(approved.approvedCreativeHash, saved.creativeHash);
	const edited = await m.bookings.updateSponsorshipCreative({ account: s.user.account, bookingId: saved._id, input: { ...sponsorCreative, body: "Changed sponsor copy." } });
	assert.equal(edited.approvedCreativeHash, undefined); assert.equal(edited.approvedAt, undefined);
	await assert.rejects(m.bookings.approveSponsorshipCreative({ account: s.user.account, bookingId: saved._id, expectedHash: saved.creativeHash, actorId: String(s.user.account.ownerId) }), error => error.code === "conflict");
	const other = await sponsorshipSeller(m, fake);
	await assert.rejects(m.bookings.updateSponsorshipCreative({ account: other.user.account, bookingId: saved._id, input: sponsorCreative }), error => error.code === "not_found");
});
