import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { mockStripe, startTestApp } from "./helpers/app.mjs";
import { createSeller, installFakeStripe } from "./helpers/shop.mjs";
let app, m, fake, counter = 0;
before(async () => {
	app = await startTestApp(); fake = installFakeStripe();
	m = { groups: await import("../lib/group-subscriptions.js"), billing: await import("../lib/group-billing.js"), events: await import("../lib/payments/events.js"), Group: (await import("../models/GroupSubscription.js")).default, Contact: (await import("../models/Contact.js")).default, Newsletter: (await import("../models/Newsletter.js")).default };
});
after(() => app?.stop());
async function setup() {
	const user = await createSeller(`group-billing${++counter}@example.com`, { fake });
	await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { groupSubscriptions: { enabled: true }, paidTier: { enabled: true, currency: "usd" }, paidTiers: [{ id: "basic", name: "Basic", prices: { month: 800 } }] } });
	user.newsletter = await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
	const checkout = await m.groups.createGroupCheckout({ account: user.account, newsletter: user.newsletter, input: { tierId: "basic", option: "month", seats: 3, email: "buyer@example.com", externalId: randomUUID() } });
	const group = await m.groups.findGroup(user.account, checkout.id);
	const customer = fake.addCustomer({ email: "verified-buyer@example.com" });
	const end = Math.floor(Date.now() / 1000) + 30 * 86400;
	const subscription = fake.addSubscription({ customer: customer.id, metadata: fake.sessions.get(group.stripeSessionId).subscription_data.metadata, current_period_end: end, items: { data: [{ id: "si_group", quantity: 3, price: { id: group.priceId, billing_scheme: "per_unit", unit_amount: 800, currency: "usd", recurring: { interval: "month", interval_count: 1, usage_type: "licensed" } } }] } });
	const invoice = { id: `in_group_${counter}`, customer: customer.id, subscription: subscription.id, status: "paid", paid: true, currency: "usd", total: 2400, amount_paid: 2400, amount_due: 2400, status_transitions: { paid_at: Math.floor(Date.now() / 1000) }, lines: { data: [{ price: group.priceId, quantity: 3, amount: 2400, period: { end } }] } };
	fake.invoices.set(invoice.id, invoice); subscription.latest_invoice = invoice.id;
	fake.paidSession(group.stripeSessionId, { subscription: subscription.id, customer: customer.id });
	return { user, group, subscription, customer, invoice };
}
const refresh = s => m.billing.refreshGroupBilling({ account: s.user.account, groupId: s.group._id });

test("checkout fulfillment binds verified group billing and never enrolls its buyer", async () => {
	const s = await setup(), count = await m.Contact.countDocuments({ accountId: s.user.accountId });
	const event = fake.event("checkout.session.completed", fake.sessions.get(s.group.stripeSessionId), { account: s.user.stripeAccountId });
	const result = await m.events.handlePaymentEvent(event);
	assert.equal(result.capacity, 3);
	const group = await m.groups.findGroup(s.user.account, s.group._id);
	assert.equal(group.status, "active"); assert.equal(group.buyerEmail, s.customer.email); assert.ok(group.buyerVerifiedAt); assert.equal(group.stripeCustomerId, s.customer.id); assert.equal(group.verifiedInvoiceId, s.invoice.id);
	assert.equal(await m.Contact.countDocuments({ accountId: s.user.accountId }), count);
	assert.equal((await m.events.handlePaymentEvent(event)).duplicate, true);
	assert.equal(String(await m.billing.findGroupAccountId(s.invoice)), String(s.user.accountId));
	s.subscription.status = "past_due";
	await m.events.handlePaymentEvent(fake.event("invoice.payment_failed", s.invoice, { account: s.user.stripeAccountId }));
	assert.equal((await m.groups.findGroup(s.user.account, s.group._id)).capacity, 0);
	assert.equal(await m.Contact.countDocuments({ accountId: s.user.accountId }), count);
});

test("unpaid quantity expansion cannot fund new seats, and current cancellation beats old paid events", async () => {
	const s = await setup(); const paid = await refresh(s);
	s.subscription.items.data[0].quantity = 5;
	s.subscription.current_period_end += 30 * 86400;
	s.subscription.latest_invoice = { ...s.invoice, id: `in_unpaid_${counter}`, status: "open", paid: false, lines: { data: [{ ...s.invoice.lines.data[0], quantity: 5, period: { end: s.subscription.current_period_end } }] } };
	const pending = await refresh(s);
	assert.equal(pending.capacity, 3); assert.equal(+pending.paidUntil, +paid.paidUntil);
	s.subscription.status = "canceled";
	await m.events.handlePaymentEvent(fake.event("invoice.paid", s.invoice, { account: s.user.stripeAccountId }));
	const canceled = await m.groups.findGroup(s.user.account, s.group._id);
	assert.equal(canceled.capacity, 0); assert.equal(canceled.status, "canceled");
});

test("invoice listing preserves actual amounts, unknowns and subscription ownership", async () => {
	const s = await setup(); await refresh(s);
	s.invoice.hosted_invoice_url = "https://invoice.stripe.com/i/test"; s.invoice.invoice_pdf = "https://evil.example.com/private.pdf";
	delete s.invoice.total;
	const result = await m.billing.listGroupInvoices({ account: s.user.account, groupId: s.group._id });
	assert.equal(result.invoices.length, 1); assert.equal(result.invoices[0].totalMinor, null); assert.equal(result.invoices[0].amountPaidMinor, 2400); assert.equal(result.invoices[0].hostedUrl, s.invoice.hosted_invoice_url); assert.equal(result.invoices[0].pdfUrl, null);
	const other = await setup();
	await assert.rejects(m.billing.listGroupInvoices({ account: other.user.account, groupId: s.group._id }), error => error.code === "not_found");
	const handler = fake.handler;
	mockStripe(request => request.path === "/v1/invoices" ? { data: [{ ...s.invoice, customer: other.customer.id }], has_more: false } : handler(request));
	try { await assert.rejects(m.billing.listGroupInvoices({ account: s.user.account, groupId: s.group._id }), error => error.code === "conflict"); }
	finally { mockStripe(handler); }
});

test("group portal has a separate restrictive configuration and refuses a broadened one", async () => {
	const s = await setup(); await refresh(s);
	const defaults = fake.portalConfigurations.length;
	const result = await m.billing.createGroupPortal({ account: s.user.account, groupId: s.group._id, returnUrl: "https://example.com/reader/groups/manage" });
	assert.match(result.url, /^https:\/\/billing\.stripe\.test/);
	const configuration = fake.portalConfigurations.at(-1);
	assert.equal(fake.portalConfigurations.length, defaults + 1); assert.equal(configuration.is_default, false); assert.equal(configuration.features.subscription_update.enabled, false); assert.equal(configuration.features.customer_update.enabled, false);
	await m.billing.createGroupPortal({ account: s.user.account, groupId: s.group._id, returnUrl: "https://example.com/reader/groups/manage" });
	assert.equal(fake.portalConfigurations.length, defaults + 1);
	configuration.features.customer_update.enabled = true;
	await assert.rejects(m.billing.createGroupPortal({ account: s.user.account, groupId: s.group._id, returnUrl: "https://example.com" }), error => error.code === "conflict");
});

test("a late billing response cannot overwrite a newer current subscription read", async () => {
	const s = await setup(); await refresh(s);
	const handler = fake.handler;
	let unblock, entered;
	const gate = new Promise(resolve => { unblock = resolve; });
	const reading = new Promise(resolve => { entered = resolve; });
	let first = true;
	mockStripe(async request => {
		if (first && request.path === `/v1/subscriptions/${s.subscription.id}`) {
			first = false; const answer = await handler(request); entered(); await gate; return answer;
		}
		return handler(request);
	});
	try {
		const old = refresh(s); const rejected = assert.rejects(old, error => error.code === "conflict");
		await reading; s.subscription.status = "past_due"; await refresh(s); unblock(); await rejected;
		assert.equal((await m.groups.findGroup(s.user.account, s.group._id)).capacity, 0);
	} finally { unblock(); mockStripe(handler); }
});

test("group billing rejects changed identity and hides raw provider diagnostics", async () => {
	const s = await setup(); await refresh(s);
	s.subscription.metadata.newsletterId = "000000000000000000000000";
	await assert.rejects(refresh(s), error => error.code === "conflict");
	fake.failNext(`GET /v1/subscriptions/${s.subscription.id}`, { status: 500, error: { message: "Secret buyer@example.com diagnostic", code: "api_error" } });
	await assert.rejects(refresh(s), error => error.code === "unavailable" && !error.message.includes("buyer@example.com"));
});

test("a group portal refuses a customer shared with an outside subscription or one-off invoice", async () => {
	const s = await setup(); await refresh(s);
	const outsider = fake.addSubscription({ customer: s.customer.id, metadata: {} });
	await assert.rejects(m.billing.createGroupPortal({ account: s.user.account, groupId: s.group._id, returnUrl: "https://example.com" }), error => error.code === "conflict");
	fake.subscriptions.delete(outsider.id);
	fake.invoices.set("in_unrelated_sale", { id: "in_unrelated_sale", customer: s.customer.id, subscription: null });
	await assert.rejects(m.billing.createGroupPortal({ account: s.user.account, groupId: s.group._id, returnUrl: "https://example.com" }), error => error.code === "conflict");
	assert.equal(fake.requests.filter(request => request.path === "/v1/billing_portal/sessions" && request.params.customer === s.customer.id).length, 0);
});
