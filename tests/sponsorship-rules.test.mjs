import assert from "node:assert/strict";
import { test } from "node:test";
import { canPlaceSponsorship, checkSponsorCreative, checkSponsorshipDay, readSponsorshipInvoice } from "../lib/sponsorship-rules.js";

const id = digit => String(digit).repeat(24);
const booking = { _id: id(1), accountId: id(2), newsletterId: id(3), slotId: id(4), stripeInvoiceId: "in_booking", stripeCustomerId: "cus_booking", stripeInvoiceItemId: "ii_booking", amountMinor: 25000, currency: "usd" };
const invoice = () => ({ id: booking.stripeInvoiceId, customer: booking.stripeCustomerId, metadata: { flockstack: "1", kind: "sponsorship", accountId: booking.accountId, newsletterId: booking.newsletterId, bookingId: booking._id, slotId: booking.slotId }, currency: "usd", collection_method: "send_invoice", status: "paid", paid: true, total: 25000, amount_paid: 25000, amount_due: 25000, lines: { data: [{ invoice_item: booking.stripeInvoiceItemId, amount: booking.amountMinor, currency: "usd" }] } });

test("sponsorship availability is a real planned day in its explicit zone, never a delivery promise", () => {
	const now = Date.parse("2026-10-25T00:30:00Z");
	assert.equal(checkSponsorshipDay("2026-10-24", "America/Los_Angeles", now), null);
	assert.ok(checkSponsorshipDay("2026-10-24", "Europe/Madrid", now));
	assert.ok(checkSponsorshipDay("2026-02-30", "UTC", now)); assert.ok(checkSponsorshipDay("2026-10-25", "Mars/Base", now));
	assert.ok(checkSponsorshipDay("2035-01-01", "UTC", now));
});

test("creative approval covers every normalized word, destination and uploaded asset reference", () => {
	const input = { headline: "Sponsor", body: "A useful offer.", callToAction: "Learn more", url: "https://example.com/offer", assetId: id(5) };
	const approved = checkSponsorCreative(input); assert.ok(approved.hash);
	assert.equal(checkSponsorCreative({ ...input, body: " A useful offer.\r\n" }).hash, approved.hash);
	for (const patch of [{ body: "Changed" }, { url: "https://example.com/other" }, { assetId: id(6) }, { headline: "New sponsor" }]) assert.notEqual(checkSponsorCreative({ ...input, ...patch }).hash, approved.hash);
	for (const url of ["javascript:alert(1)", "http://127.0.0.1/", "https://user:secret@example.com/", "https://example.com:8443/"]) assert.ok(checkSponsorCreative({ ...input, url }).problem);
});

test("a paid sponsorship invoice requires the exact buyer, booking and agreed single line", () => {
	assert.equal(readSponsorshipInvoice(invoice(), booking).funded, true);
	const foreign = invoice(); foreign.metadata.bookingId = id(9);
	assert.equal(readSponsorshipInvoice(foreign, booking).owned, false);
	for (const mutate of [value => value.currency = "eur", value => value.lines.data[0].amount++, value => value.customer = "cus_other", value => value.lines.has_more = true, value => value.application_fee_amount = 100, value => value.collection_method = "charge_automatically", value => value.subscription = "sub_recurring"]) {
		const value = invoice(); mutate(value); assert.equal(readSponsorshipInvoice(value, booking).funded, false);
	}
});

test("new invoice-line shape works, unpaid invoices grant no placement and missing money stays unknown", () => {
	const value = invoice(); delete value.lines.data[0].invoice_item;
	value.lines.data[0].parent = { invoice_item_details: { invoice_item: booking.stripeInvoiceItemId } };
	delete value.total; value.amount_paid = 0; value.status = "open"; value.paid = false;
	const read = readSponsorshipInvoice(value, booking);
	assert.equal(read.supported, true); assert.equal(read.funded, false); assert.equal(read.observed.totalMinor, null); assert.equal(read.observed.amountPaidMinor, 0); assert.equal(read.observed.paidAt, null);
});

test("only an approved, paid, reserved placement can reach its own campaign or that campaign's resend", () => {
	const paid = { ...booking, status: "paid", invoiceFunded: true, approvedCreativeHash: "approved", campaignId: id(7) };
	const slot = { _id: booking.slotId, accountId: booking.accountId, newsletterId: booking.newsletterId, bookingId: booking._id, status: "reserved" };
	const campaign = { _id: id(7), accountId: booking.accountId, newsletterId: booking.newsletterId, kind: "issue", publishTo: "both" };
	const allowed = extra => canPlaceSponsorship({ booking: paid, slot, campaign, creativeHash: "approved", ...extra });
	assert.equal(allowed(), true);
	assert.equal(allowed({ booking: { ...paid, status: "invoiced" } }), false);
	assert.equal(allowed({ creativeHash: "edited" }), false);
	assert.equal(allowed({ campaign: { ...campaign, newsletterId: id(9) } }), false);
	assert.equal(allowed({ campaign: { ...campaign, publishTo: "web" } }), false);
	assert.equal(allowed({ slot: { ...slot, bookingId: id(8) } }), false);
	assert.equal(allowed({ campaign: { ...campaign, _id: id(8), resend: { of: id(7) } } }), true);
});
