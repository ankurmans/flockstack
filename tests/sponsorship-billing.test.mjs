import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mockStripe, startTestApp } from "./helpers/app.mjs";
import { installFakeStripe } from "./helpers/shop.mjs";
import { sponsorRequest, sponsorshipModels, sponsorshipSeller } from "./helpers/sponsorships.mjs";
let app, m, fake;
before(async () => { app = await startTestApp(); fake = installFakeStripe(); m = { ...(await sponsorshipModels()), billing: await import("../lib/sponsorship-billing.js") }; });
after(() => app?.stop());
async function setup() {
	const s = await sponsorshipSeller(m, fake), request = await sponsorRequest(m, s);
	await m.bookings.verifySponsorshipRequest(request.token);
	const booking = await m.inventory.acceptSponsorshipBooking({ account: s.user.account, bookingId: request.booking._id });
	return { ...s, booking };
}
const create = s => m.billing.createSponsorshipInvoice({ account: s.user.account, bookingId: s.booking._id });
const refresh = s => m.billing.refreshSponsorshipInvoice({ account: s.user.account, bookingId: s.booking._id });
function pay(invoice) { Object.assign(invoice, { status: "paid", paid: true, amount_paid: invoice.total, amount_remaining: 0, status_transitions: { paid_at: Math.floor(Date.now() / 1000) } }); }

test("one accepted sponsorship creates its own payable invoice and exact line without charging or emailing", async () => {
	const s = await setup(), start = fake.requests.length, invoiced = await create(s);
	assert.equal(invoiced.status, "invoiced"); assert.equal(invoiced.invoiceFunded, false);
	const invoice = fake.invoices.get(invoiced.stripeInvoiceId);
	assert.equal(invoice.collection_method, "send_invoice"); assert.equal(invoice.auto_advance, false); assert.equal(invoice.pending_invoice_items_behavior, "exclude");
	assert.equal(invoice.lines.data.length, 1); assert.equal(invoice.total, s.booking.amountMinor); assert.equal(invoice.currency, "usd");
	assert.equal(invoiced.invoice.totalMinor, 25000); assert.match(invoiced.invoice.hostedUrl, /^https:\/\/invoice\.stripe\.com\//);
	assert.equal(fake.customers.get(invoiced.stripeCustomerId).email, s.booking.email);
	const calls = fake.requests.slice(start);
	assert.ok(calls.every(request => request.account === s.user.stripeAccountId));
	assert.equal(calls.some(request => /\/(pay|send)$|\/charges$/.test(request.path)), false);
	assert.equal(calls.some(request => JSON.stringify(request.params).includes("application_fee")), false);
	await create(s);
	assert.equal([...fake.invoices.values()].filter(row => row.metadata?.bookingId === String(s.booking._id)).length, 1);
	assert.equal([...fake.invoiceItems.values()].filter(row => row.metadata?.bookingId === String(s.booking._id)).length, 1);
	assert.equal(await m.Contact.countDocuments({ accountId: s.user.accountId }), 0);
});

test("actual payment refresh funds the booking and validates ownership without converting missing money to zero", async () => {
	const s = await setup(), created = await create(s), invoice = fake.invoices.get(created.stripeInvoiceId);
	pay(invoice); delete invoice.total;
	const paid = await refresh(s);
	assert.equal(paid.status, "paid"); assert.equal(paid.invoiceFunded, true); assert.equal(paid.invoice.totalMinor, null); assert.equal(paid.invoice.amountPaidMinor, 25000);
	invoice.metadata.bookingId = "0".repeat(24);
	await assert.rejects(refresh(s), error => error.code === "conflict");
	const other = await setup();
	await assert.rejects(m.billing.refreshSponsorshipInvoice({ account: other.user.account, bookingId: s.booking._id }), error => error.code === "not_found");
});

test("a lost invoice-item response recovers its already-created bound line without duplicating the sale", async () => {
	const s = await setup(), handler = fake.handler;
	let first = true;
	mockStripe(async request => {
		if (first && request.method === "POST" && request.path === "/v1/invoiceitems") { first = false; await handler(request); return { status: 500, error: { message: "Lost response for advertiser@example.com", code: "api_error" } }; }
		return handler(request);
	});
	try { await assert.rejects(create(s), error => error.code === "unavailable" && !error.message.includes("advertiser@example.com")); }
	finally { mockStripe(handler); }
	const result = await create(s);
	assert.equal(result.status, "invoiced");
	assert.equal([...fake.invoices.values()].filter(row => row.metadata?.bookingId === String(s.booking._id)).length, 1);
	assert.equal(fake.invoices.get(result.stripeInvoiceId).lines.data.length, 1);
});

test("unknown creation older than 23 hours needs review, while known draft IDs can safely resume finalization", async () => {
	const s = await setup();
	await m.Booking.updateOne({ accountId: s.user.accountId, _id: s.booking._id }, { $set: { invoiceStartedAt: new Date(Date.now() - 24 * 3600000) } });
	const count = fake.requests.length;
	await assert.rejects(create(s), error => error.code === "conflict"); assert.equal(fake.requests.length, count);
	await m.Booking.updateOne({ accountId: s.user.accountId, _id: s.booking._id }, { $unset: { invoiceStartedAt: 1 } });
	fake.failNext("POST /v1/invoices", { status: 500, error: { message: "Provider unavailable", code: "api_error" } });
	await assert.rejects(create(s), error => error.code === "unavailable"); fake.recover("POST /v1/invoices");
	const handler = fake.handler;
	mockStripe(request => request.method === "POST" && /\/finalize$/.test(request.path) ? { status: 500, error: { message: "Finalization unavailable", code: "api_error" } } : handler(request));
	try { await assert.rejects(create(s), error => error.code === "unavailable"); } finally { mockStripe(handler); }
	const created = await m.Booking.findOne({ accountId: s.user.accountId, _id: s.booking._id }).lean();
	assert.ok(created.stripeInvoiceItemId); assert.equal(fake.invoices.get(created.stripeInvoiceId).status, "draft");
	await m.Booking.updateOne({ accountId: s.user.accountId, _id: s.booking._id }, { $set: { invoiceStartedAt: new Date(Date.now() - 24 * 3600000) } });
	// A known invoice can be finalized by identity; no new customer, invoice or item needs to be created.
	await create(s); assert.equal(fake.invoices.get(created.stripeInvoiceId).status, "open"); assert.equal([...fake.invoices.values()].filter(row => row.metadata?.bookingId === String(s.booking._id)).length, 1);
});

test("a stale invoice read cannot overwrite a newer paid observation", async () => {
	const s = await setup(), created = await create(s), handler = fake.handler;
	let unblock, entered, first = true;
	const gate = new Promise(resolve => { unblock = resolve; }), started = new Promise(resolve => { entered = resolve; });
	mockStripe(async request => {
		if (first && request.method === "GET" && request.path === `/v1/invoices/${created.stripeInvoiceId}`) { first = false; const old = structuredClone(await handler(request)); entered(); await gate; return old; }
		return handler(request);
	});
	try {
		const pending = assert.rejects(refresh(s), error => error.code === "conflict"); await started;
		pay(fake.invoices.get(created.stripeInvoiceId)); await refresh(s); unblock(); await pending;
		assert.equal((await m.Booking.findOne({ accountId: s.user.accountId, _id: s.booking._id }).lean()).status, "paid");
	} finally { unblock(); mockStripe(handler); }
});
