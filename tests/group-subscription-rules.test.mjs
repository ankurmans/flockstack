import assert from "node:assert/strict";
import { test } from "node:test";
import { groupAccessProjection, groupSeatEntitlement, readGroupFunding } from "../lib/group-subscription-rules.js";
import { isPaidContact } from "../lib/tiers.js";
const NOW = Date.parse("2026-10-25T12:00:00Z"), END = NOW + 30 * 86400000;
const subscription = extra => ({ id: "sub_group", status: "active", items: { data: [{ quantity: 3, current_period_end: END / 1000, price: { id: "price_group", currency: "usd", billing_scheme: "per_unit", unit_amount: 800, recurring: { interval: "month", interval_count: 1, usage_type: "licensed" } } }] }, ...extra });
const invoice = extra => ({ id: "in_group", currency: "usd", status: "paid", paid: true, subscription: "sub_group", lines: { data: [{ price: { id: "price_group" }, quantity: 3, amount: 2400, period: { end: END / 1000 } }] }, ...extra });
const funding = (sub, bill, previous) => readGroupFunding({ subscription: sub ?? subscription(), invoice: bill ?? invoice(), previous, now: NOW });

test("licensed group funding comes from the current paid recurring invoice, including the newer invoice shape", () => {
	const result = funding(); assert.equal(result.supported, true); assert.equal(result.capacity, 3); assert.equal(+result.paidUntil, END); assert.equal(result.verifiedInvoiceId, "in_group");
	const modern = invoice({ subscription: undefined, parent: { subscription_details: { subscription: "sub_group" } }, lines: { data: [{ pricing: { price_details: { price: "price_group" } }, quantity: 3, amount: 2400, period: { end: END / 1000 } }] } });
	assert.equal(funding(subscription(), modern).capacity, 3);
});

test("an active status alone never grants or extends unpaid seats; a reduction is honored immediately", () => {
	const unpaid = invoice({ status: "open", paid: false });
	assert.equal(funding(subscription(), unpaid).capacity, 0);
	const previous = { capacity: 2, paidUntil: new Date(NOW + 86400000), verifiedInvoiceId: "in_previous" };
	const result = funding(subscription(), unpaid, previous); assert.equal(result.capacity, 2); assert.equal(+result.paidUntil, +previous.paidUntil); assert.equal(result.paymentVerified, false);
	const smaller = subscription(); smaller.items.data[0].quantity = 1;
	assert.equal(funding(smaller, unpaid, previous).capacity, 1);
	assert.equal(funding(subscription({ status: "past_due" }), invoice(), previous).capacity, 0);
	assert.equal(funding(subscription({ status: "canceled" }), invoice(), previous).capacity, 0);
});

test("unrelated, old, negative-credit or partial-quantity invoices cannot fund a larger licensed group", () => {
	for (const bill of [invoice({ subscription: "sub_other" }), invoice({ currency: "eur" }), invoice({ id: null }), invoice({ paid: false }), invoice({ lines: { data: [{ price: { id: "price_group" }, quantity: 3, amount: -2400, period: { end: END / 1000 } }] } }), invoice({ lines: { data: [{ price: { id: "price_group" }, quantity: 1, amount: 800, period: { end: END / 1000 } }] } }), invoice({ lines: { data: [{ price: { id: "price_group" }, quantity: 3, amount: 2400, period: { end: NOW / 1000 } }] } })]) assert.equal(funding(subscription(), bill).capacity, 0);
	assert.equal(funding(subscription(), invoice(), { priceId: "price_changed" }).supported, false);
	const metered = subscription(); metered.items.data[0].price.recurring.usage_type = "metered";
	assert.equal(funding(metered).supported, false);
	assert.equal(funding(subscription({ items: { data: [], has_more: true } })).supported, false);
});

test("seat access requires current licensed position, exact reader identity and consent, and never extends with Stripe grace", () => {
	const contact = { _id: "reader", accountId: "account", newsletterId: "newsletter", email: "reader@example.com", status: "active" };
	const seat = { id: "seat", contactId: "reader", email: contact.email, status: "active", consentedAt: new Date(NOW - 1000) };
	const group = { _id: "group", status: "active", accountId: "account", newsletterId: "newsletter", tierId: "premium", subscriptionStatus: "active", paidUntil: new Date(END), capacity: 1, seats: [seat] };
	const access = groupSeatEntitlement(group, seat.id, contact, NOW); assert.ok(access);
	assert.equal(isPaidContact(groupAccessProjection(access), END - 1), true); assert.equal(isPaidContact(groupAccessProjection(access), END), false);
	for (const changed of [{ accountId: "other" }, { newsletterId: "other" }, { email: "changed@example.com" }, { status: "unsubscribed" }, { _id: "other" }]) assert.equal(groupSeatEntitlement(group, seat.id, { ...contact, ...changed }, NOW), null);
	for (const changed of [{ subscriptionStatus: "past_due" }, { capacity: 0 }, { paidUntil: new Date(NOW) }, { seats: [{ ...seat, consentedAt: undefined }] }, { seats: [{ id: "reserved", status: "invited" }, seat] }]) assert.equal(groupSeatEntitlement({ ...group, ...changed }, seat.id, contact, NOW), null);
});
