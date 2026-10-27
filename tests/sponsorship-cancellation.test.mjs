import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mockStripe, startTestApp } from "./helpers/app.mjs";
import { installFakeStripe } from "./helpers/shop.mjs";
import { sponsorRequest, sponsorshipModels, sponsorshipSeller } from "./helpers/sponsorships.mjs";
let app, m, fake;
before(async () => { app = await startTestApp(); fake = installFakeStripe(); m = { ...(await sponsorshipModels()), billing: await import("../lib/sponsorship-billing.js"), cancellation: await import("../lib/sponsorship-cancellation.js"), events: await import("../lib/payments/events.js"), paymentEvents: await import("../lib/sponsorship-payment-events.js") }; });
after(() => app?.stop());
async function setup({ invoice = true } = {}) {
	const s = await sponsorshipSeller(m, fake), created = await sponsorRequest(m, s);
	await m.bookings.verifySponsorshipRequest(created.token);
	let booking = await m.inventory.acceptSponsorshipBooking({ account: s.user.account, bookingId: created.booking._id });
	if (invoice) booking = await m.billing.createSponsorshipInvoice({ account: s.user.account, bookingId: booking._id });
	return { ...s, booking };
}
const cancel = (s, extra = {}) => m.cancellation.cancelSponsorship({ account: s.user.account, bookingId: s.booking._id, ...extra });
const slot = s => m.Slot.findOne({ accountId: s.user.accountId, _id: s.slot._id }).lean();
function pay(invoice) { Object.assign(invoice, { status: "paid", paid: true, amount_paid: invoice.total, amount_remaining: 0, status_transitions: { paid_at: Math.floor(Date.now() / 1000) } }); }

test("an unfinished draft keeps its date reserved and asks for recovery before a finalized invoice can be voided", async () => {
	const s = await setup(); fake.invoices.get(s.booking.stripeInvoiceId).status = "draft";
	const before = fake.requests.length;
	await assert.rejects(cancel(s), /Recover and finalize this draft/);
	assert.equal((await slot(s)).status, "reserved");
	assert.equal(fake.requests.slice(before).some(request => request.method !== "GET"), false);
});

test("an unbilled buyer withdrawal releases only its own reservation and repeats safely", async () => {
	const s = await setup({ invoice: false });
	assert.equal((await cancel(s, { managerVersion: 0 })).status, "canceled"); assert.equal((await slot(s)).status, "open");
	const next = await sponsorRequest(m, s, { email: "next-sponsor@example.com" }); await m.bookings.verifySponsorshipRequest(next.token);
	await m.inventory.acceptSponsorshipBooking({ account: s.user.account, bookingId: next.booking._id });
	await cancel(s, { managerVersion: 0 });
	assert.equal(String((await slot(s)).bookingId), String(next.booking._id));
});

test("unpaid invoice cancellation confirms Stripe void before it releases the date", async () => {
	const s = await setup(), invoice = fake.invoices.get(s.booking.stripeInvoiceId);
	await assert.rejects(cancel(s, { managerVersion: 0 }), error => error.code === "conflict");
	fake.failNext(`POST /v1/invoices/${invoice.id}/void`, { status: 500, error: { message: "Provider unavailable", code: "api_error" } });
	await assert.rejects(cancel(s), error => error.code === "unavailable");
	assert.equal((await slot(s)).status, "reserved");
	assert.ok((await m.Booking.findOne({ accountId: s.user.accountId, _id: s.booking._id }).lean()).cancelingAt);
	fake.recover(`POST /v1/invoices/${invoice.id}/void`);
	const canceled = await cancel(s);
	assert.equal(canceled.status, "canceled"); assert.equal(canceled.invoice.status, "void"); assert.equal(canceled.invoiceFunded, false); assert.equal((await slot(s)).status, "open");
});

test("a paid cancellation needs explicit refund acknowledgment and never fabricates or issues a refund", async () => {
	const s = await setup(), invoice = fake.invoices.get(s.booking.stripeInvoiceId); pay(invoice);
	await assert.rejects(cancel(s), error => error.code === "conflict"); assert.equal((await slot(s)).status, "reserved");
	const before = fake.requests.length;
	const canceled = await cancel(s, { acknowledgeNoRefund: true });
	assert.equal(canceled.status, "canceled"); assert.equal(canceled.invoice.status, "paid"); assert.equal(canceled.invoice.amountPaidMinor, 25000); assert.equal((await slot(s)).status, "open");
	assert.equal(fake.requests.slice(before).some(request => request.method !== "GET"), false, "there is no refund or void call for a paid invoice");
	await m.billing.refreshSponsorshipInvoice({ account: s.user.account, bookingId: s.booking._id });
	const retained = await m.Booking.findOne({ accountId: s.user.accountId, _id: s.booking._id }).lean(); assert.equal(retained.status, "canceled"); assert.equal(retained.invoiceFunded, false);
});

test("a payment racing invoice void cannot release the date without a new explicit paid decision", async () => {
	const s = await setup(), handler = fake.handler;
	mockStripe(request => { if (request.method === "POST" && request.path === `/v1/invoices/${s.booking.stripeInvoiceId}/void`) pay(fake.invoices.get(s.booking.stripeInvoiceId)); return handler(request); });
	try { await assert.rejects(cancel(s), error => error.code === "conflict"); }
	finally { mockStripe(handler); }
	assert.equal((await slot(s)).status, "reserved");
	assert.equal((await m.Booking.findOne({ accountId: s.user.accountId, _id: s.booking._id }).lean()).status, "paid");
});

test("verified payment events refresh the current invoice once and never enroll an advertiser as a reader", async () => {
	const s = await setup(), invoice = fake.invoices.get(s.booking.stripeInvoiceId); pay(invoice);
	const event = fake.event("invoice.paid", structuredClone(invoice), { account: s.user.stripeAccountId });
	const result = await m.events.handlePaymentEvent(event);
	assert.equal(result.sponsorshipId, String(s.booking._id)); assert.equal(result.status, "paid");
	assert.equal((await m.events.handlePaymentEvent(event)).duplicate, true);
	assert.equal(String(await m.paymentEvents.findSponsorshipInvoiceAccountId(invoice)), String(s.user.accountId));
	assert.equal(await m.Contact.countDocuments({ accountId: s.user.accountId }), 0);
	await cancel(s, { acknowledgeNoRefund: true });
	await m.events.handlePaymentEvent(fake.event("invoice.updated", invoice, { account: s.user.stripeAccountId }));
	assert.equal((await m.Booking.findOne({ accountId: s.user.accountId, _id: s.booking._id }).lean()).status, "canceled");
});
