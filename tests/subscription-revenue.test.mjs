import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { as, callApi, form, platformEmails, startTestApp } from "./helpers/app.mjs";
import { WEBHOOK_SECRET, api, createSeller, installFakeStripe, postPaymentEvent } from "./helpers/shop.mjs";
import { setTier } from "./helpers/paid.mjs";
import { sent as sesEmails } from "./stubs/ses.mjs";

let app, m, fake, sequence = 0;
const DAY = 86400000;
before(async () => {
	app = await startTestApp({ STRIPE_PAYMENTS_WEBHOOK_SECRET: WEBHOOK_SECRET });
	m = {
		rules: await import("../lib/subscription-revenue-rules.js"), observations: await import("../lib/subscription-revenue.js"), reports: await import("../lib/subscription-revenue-report.js"),
		Financial: (await import("../models/SubscriptionFinancial.js")).default, Change: (await import("../models/SubscriptionChange.js")).default, Invoice: (await import("../models/SubscriptionInvoice.js")).default,
		Contact: (await import("../models/Contact.js")).default, Newsletter: (await import("../models/Newsletter.js")).default, Imported: (await import("../models/ImportedSubscription.js")).default,
		purge: await import("../lib/account-purge.js"), keys: await import("../app/(app)/api-keys/actions.js"),
		page: (await import("../app/(app)/reports/revenue/page.js")).default, Tooltip: (await import("../components/ui/tooltip.jsx")).TooltipProvider,
	};
});
beforeEach(() => { fake = installFakeStripe(); });
after(() => app?.stop());

function subscription(extra = {}) {
	return { id: `sub_finance_${++sequence}`, object: "subscription", status: "active", currency: "usd", current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400, metadata: { tierId: "basic" }, items: { has_more: false, data: [{ id: "si_finance", quantity: 1, price: { id: "price_finance", product: "prod_finance", unit_amount: 1000, currency: "usd", billing_scheme: "per_unit", tax_behavior: "exclusive", recurring: { interval: "month", interval_count: 1, usage_type: "licensed" } }, discounts: [], tax_rates: [] }] }, discounts: [], default_tax_rates: [], automatic_tax: { enabled: false }, ...extra };
}
const normal = (sub) => m.rules.normalizeSubscriptionFinancial(sub, { tierIds: ["basic", "plus"] });
async function seller() {
	const user = await createSeller(`revenue-${++sequence}@example.com`, { fake });
	await setTier(user, { monthlyCents: 9900 });
	await m.Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { paidTiers: [{ id: "basic", name: "Basic", prices: { month: 9900 } }, { id: "plus", name: "Plus", prices: { month: 19900 } }] } });
	user.newsletter = await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
	return user;
}
function owned(user, extra = {}) {
	const sub = subscription(extra); const customer = fake.addCustomer({ email: `financial-reader-${++sequence}@example.com` });
	sub.customer = customer.id; sub.metadata = { flockstack: "1", kind: "paid_tier", accountId: user.accountId, newsletterId: user.newsletterId, tierId: "basic", ...(extra.metadata ?? {}) };
	fake.subscriptions.set(sub.id, sub); return sub;
}
const observe = (user, sub, at = new Date()) => m.observations.observeSubscriptionFinancial({ account: user.account, newsletter: user.newsletter, subscription: sub, observedAt: at, source: "refresh" });
const report = (user, days = 30) => api(user, "GET", `/reports/revenue?newsletter=${user.slug}&days=${days}`);
const refresh = (user, cursor) => api(user, "POST", "/reports/revenue/refresh", { newsletter: user.slug, ...(cursor && { cursor }) });
async function event(user, type, object, extra = {}) {
	const value = { ...fake.event(type, object, { account: user.stripeAccountId }), created: Math.floor(Date.now() / 1000), ...extra };
	const result = await postPaymentEvent(value); assert.equal(result.status, 200, JSON.stringify(result.body)); return value;
}

test("MRR normalizes actual fixed Stripe prices and quantities, excludes trials, fees, free/metered and collection pauses", () => {
	const sub = subscription(); assert.equal(normal(sub).monthlyRecurringMinor, 1000);
	sub.items.data[0].quantity = 3; assert.equal(normal(sub).monthlyRecurringMinor, 3000);
	sub.items.data[0].price.recurring = { interval: "year", interval_count: 1, usage_type: "licensed" }; assert.equal(normal(sub).monthlyRecurringMinor, 250);
	sub.items.data[0].price.recurring = { interval: "month", interval_count: 3, usage_type: "licensed" }; assert.equal(normal(sub).monthlyRecurringMinor, 1000);
	assert.equal(normal({ ...sub, status: "trialing", metadata: { trialAmountCents: "500" } }).monthlyRecurringMinor, 0);
	assert.equal(normal({ ...sub, pause_collection: { behavior: "void" } }).monthlyRecurringMinor, 0);
	assert.equal(normal({ ...sub, status: "past_due" }).monthlyRecurringMinor, 1000);
	sub.items.data[0].current_trial = { id: "trial_current" }; assert.equal(normal(sub).monthlyRecurringMinor, 0); delete sub.items.data[0].current_trial;
	sub.items.data[0].price.recurring.usage_type = "metered"; assert.equal(normal(sub).monthlyRecurringMinor, 0);
	sub.items.data[0].price.recurring.usage_type = "licensed"; delete sub.items.data[0].quantity; assert.equal(normal(sub).monthlyRecurringMinor, null);
	assert.equal(normal(subscription({ status: "future_status" })).monthlyRecurringMinor, null);
});

test("known recurring discounts reduce MRR; one-time/expired coupons do not, and hidden scope or tax adjustments stay unknown", () => {
	const sub = subscription();
	sub.discounts = [{ id: "di_percent", coupon: { duration: "forever", percent_off: 25, applies_to: null } }]; assert.equal(normal(sub).monthlyRecurringMinor, 750);
	sub.discounts.push({ source: { coupon: { duration: "forever", amount_off: 100, currency: "usd", applies_to: null } } }); assert.equal(normal(sub).monthlyRecurringMinor, 650);
	sub.discounts[0].coupon.duration = "once"; assert.equal(normal(sub).monthlyRecurringMinor, 900);
	sub.discounts[1].end = Math.floor(Date.now() / 1000) - 1; assert.equal(normal(sub).monthlyRecurringMinor, 1000);
	sub.discounts = ["di_opaque"]; assert.equal(normal(sub).grossMonthlyMinor, 1000); assert.equal(normal(sub).monthlyRecurringMinor, null);
	sub.discounts = [{ coupon: { duration: "forever", percent_off: 50 } }]; assert.equal(normal(sub).reason, "discount_product_unknown");
	sub.discounts = [{ coupon: { duration: "forever", percent_off: 50, applies_to: { products: ["prod_other"] } } }]; assert.equal(normal(sub).monthlyRecurringMinor, 1000);
	sub.discounts = []; sub.items.data[0].price.tax_behavior = "inclusive"; assert.equal(normal(sub).monthlyRecurringMinor, null); assert.equal(normal(sub).grossMonthlyMinor, 1000);
	sub.items.data[0].price.tax_behavior = "exclusive"; sub.items.data[0].price.currency = "eur"; assert.equal(normal(sub).monthlyRecurringMinor, null);
});

test("first seen is distinct from activation, churn, tier upgrade, reorder and currency change", () => {
	const before = normal(subscription()); assert.equal(m.rules.classifySubscriptionChange(null, before), "first_seen");
	const after = normal(subscription({ metadata: { tierId: "plus" } })); assert.equal(m.rules.classifySubscriptionChange(before, after), "upgraded");
	const reordered = m.rules.normalizeSubscriptionFinancial(subscription({ metadata: { tierId: "plus" } }), { tierIds: ["plus", "basic"] }); assert.equal(m.rules.classifySubscriptionChange(before, reordered), "plan_changed");
	assert.equal(m.rules.classifySubscriptionChange(before, normal(subscription({ status: "canceled" }))), "churn");
	assert.equal(m.rules.classifySubscriptionChange(before, normal(subscription({ pause_collection: { behavior: "void" } }))), "paused");
	assert.equal(m.rules.classifySubscriptionChange(before, { ...after, currency: "eur" }), "currency_changed");
});

test("verified events record actual per-currency prices and invoice payments once, without copying personal Stripe data", async () => {
	const user = await seller(); const usd = owned(user); usd.metadata.privateNote = "DO_NOT_COPY_PERSONAL_METADATA";
	usd.customer_details = { email: "do-not-copy@example.com", name: "PRIVATE_CUSTOMER_NAME" };
	const eur = owned(user, { currency: "eur" }); eur.items.data[0].price.currency = "eur"; eur.items.data[0].price.unit_amount = 2000;
	const first = await event(user, "customer.subscription.created", usd); await postPaymentEvent(first);
	await event(user, "customer.subscription.created", eur);
	const invoice = { id: `in_finance_${++sequence}`, subscription: usd.id, status: "paid", currency: "usd", amount_paid: 1500, total_excluding_tax: 1250, post_payment_credit_notes_amount: 0, paid_out_of_band: false, status_transitions: { paid_at: Math.floor(Date.now() / 1000) }, customer_email: "do-not-copy@example.com" };
	const paid = await event(user, "invoice.paid", invoice); await postPaymentEvent(paid);
	const output = await report(user); assert.equal(output.status, 200); assert.deepEqual(output.body.currencies.map((row) => row.currency), ["eur", "usd"]);
	assert.equal(output.body.currencies[0].monthlyRecurringMinor, 2000); assert.equal(output.body.currencies[1].monthlyRecurringMinor, 1000, "does not use the newsletter's 9900 list price");
	assert.equal(output.body.currencies[1].paidInvoiceMinor, 1500); assert.equal(output.body.currencies[0].paidInvoiceMinor, null);
	assert.equal(await m.Invoice.countDocuments({ accountId: user.accountId }), 1);
	const states = await m.Financial.find({ accountId: user.accountId }).lean(); assert.equal(states.length, 2);
	const serialized = JSON.stringify([states, await m.Invoice.find({ accountId: user.accountId }).lean()]); assert.doesNotMatch(serialized, /DO_NOT_COPY|PRIVATE_CUSTOMER|do-not-copy@example/);
	assert.equal(output.body.coverage.historicalComplete, false); assert.equal(output.body.observedChanges.first_seen, 2); assert.equal(output.body.observedChanges.upgraded, 0);
});

test("newer provider observations win; concurrent duplicates keep one state and one financial transition", async () => {
	const user = await seller(), sub = owned(user); const now = new Date();
	await Promise.all([observe(user, sub, now), observe(user, sub, now)]);
	assert.equal(await m.Financial.countDocuments({ accountId: user.accountId }), 1); assert.equal(await m.Change.countDocuments({ accountId: user.accountId }), 1);
	await observe(user, { ...sub, status: "canceled" }, new Date(+now + 1000));
	await observe(user, sub, new Date(+now - 1000));
	const row = await m.Financial.findOne({ accountId: user.accountId, subscriptionId: sub.id }).lean(); assert.equal(row.state.status, "canceled"); assert.equal(row.pendingChanges.length, 0);
});

test("an interrupted financial history write remains in its outbox and is counted exactly once before and after recovery", async () => {
	const user = await seller(), sub = owned(user), now = new Date();
	await observe(user, sub, new Date(+now - 40 * DAY));
	const insert = m.Change.insertMany;
	m.Change.insertMany = async () => { throw new Error("Synthetic history write outage"); };
	try { await assert.rejects(() => observe(user, { ...sub, status: "canceled" }, new Date(+now - DAY)), /Synthetic/); }
	finally { m.Change.insertMany = insert; }
	let output = await m.reports.getSubscriptionRevenueReport({ account: user.account, newsletter: user.newsletter, now });
	assert.equal(output.observedChanges.churn, 1); assert.deepEqual(output.trackedCohort, { startingSubscriptions: 1, endedCanceledOrUnpaid: 1, unknownBaseline: 0, lossRate: 1 });
	await observe(user, { ...sub, status: "canceled" }, new Date(+now - DAY));
	output = await m.reports.getSubscriptionRevenueReport({ account: user.account, newsletter: user.newsletter, now });
	assert.equal(output.observedChanges.churn, 1); assert.equal((await m.Financial.findOne({ accountId: user.accountId }).lean()).pendingChanges.length, 0);
	assert.equal(await m.Change.countDocuments({ accountId: user.accountId }), 2);
});

test("invoice source watermarks refuse stale reductions; credits and payments outside Stripe remain explicitly labelled", async () => {
	const user = await seller(), sub = owned(user), now = new Date();
	const invoice = { id: `in_order_${++sequence}`, subscription: sub.id, status: "paid", currency: "usd", amount_paid: 1000, total_excluding_tax: 800, post_payment_credit_notes_amount: 100, paid_out_of_band: true, status_transitions: { paid_at: Math.floor(+now / 1000) - 5 } };
	await m.observations.observeSubscriptionInvoice({ account: user.account, newsletter: user.newsletter, subscriptionId: sub.id, invoice, source: "refresh", observedAt: now });
	await m.observations.observeSubscriptionInvoice({ account: user.account, newsletter: user.newsletter, subscriptionId: sub.id, invoice: { ...invoice, amount_paid: 800, post_payment_credit_notes_amount: 0 }, event: { id: "evt_stale", created: Math.floor(+now / 1000) - 10 } });
	const row = await m.Invoice.findOne({ accountId: user.accountId }).lean(); assert.equal(row.amountPaidMinor, 1000); assert.equal(row.postPaymentCreditsMinor, 100);
	const output = (await report(user)).body.currencies[0]; assert.equal(output.markedPaidOutsideStripe, 1); assert.equal(output.monthlyRecurringMinor, null);
	assert.equal((await m.observations.observeSubscriptionInvoice({ account: user.account, newsletter: user.newsletter, subscriptionId: "sub_wrong", invoice })).recorded, false);
	assert.equal((await m.observations.observeSubscriptionInvoice({ account: user.account, newsletter: user.newsletter, subscriptionId: sub.id, invoice: { ...invoice, id: "in_missing_money", amount_paid: undefined } })).recorded, false);
});

test("refresh only reads the owned Stripe account, does not change access or send, and report reads do not contact Stripe", async () => {
	const user = await seller(), sub = owned(user);
	const contact = await m.Contact.create({ accountId: user.accountId, newsletterId: user.newsletterId, email: "refresh-reader@example.com", stripeSubscriptionId: sub.id, status: "unsubscribed", tier: "free" });
	const before = await m.Contact.findOne({ accountId: user.accountId, _id: contact._id }).lean();
	const requestStart = fake.requests.length, emailStart = platformEmails.length, sesStart = sesEmails.length;
	assert.equal((await refresh(user)).status, 200);
	const requests = fake.requests.slice(requestStart); assert.ok(requests.length > 0); assert.ok(requests.every((request) => request.method === "GET" && request.account === user.stripeAccountId));
	const after = await m.Contact.findOne({ accountId: user.accountId, _id: contact._id }).lean(); assert.deepEqual(after, before);
	assert.equal(platformEmails.length, emailStart); assert.equal(sesEmails.length, sesStart);
	const recorded = fake.requests.length; const output = await report(user); assert.equal(output.body.currencies[0].monthlyRecurringMinor, 1000); assert.equal(fake.requests.length, recorded);
	await as(user, async () => { const element = await m.page({ searchParams: Promise.resolve({ days: "30" }) }); const html = renderToStaticMarkup(createElement(m.Tooltip, null, element)); assert.match(html, /Calculated MRR/); assert.match(html, /\$10\.00|US\$10\.00/); });
	assert.equal(fake.requests.length, recorded);
});

test("refresh refuses a foreign newsletter before coupon reads and supports an existing explicit import mapping", async () => {
	const user = await seller(), other = await seller(); const foreign = owned(other, { discounts: ["di_private"] });
	await m.Contact.create({ accountId: user.accountId, newsletterId: user.newsletterId, email: "foreign-link@example.com", stripeSubscriptionId: foreign.id });
	let start = fake.requests.length; const refused = await refresh(user); assert.equal(refused.body.skipped, 1); assert.equal(fake.requests.length - start, 1); assert.equal(await m.Financial.countDocuments({ accountId: user.accountId }), 0);
	const imported = subscription({ metadata: {} }); fake.subscriptions.set(imported.id, imported);
	await m.Contact.create({ accountId: user.accountId, newsletterId: user.newsletterId, email: "mapped-reader@example.com", stripeSubscriptionId: imported.id });
	await m.Imported.create({ accountId: user.accountId, newsletterId: user.newsletterId, stripeSubscriptionId: imported.id, chargeAccount: user.stripeAccountId, priceId: "price_finance", tierId: "basic" });
	const refreshed = await refresh(user); assert.equal(refreshed.body.subscriptionsObserved, 1);
	assert.equal((await m.Financial.findOne({ accountId: user.accountId }).lean()).subscriptionId, imported.id);
});

test("refresh resolves modern discount IDs and explicit coupon scope without persisting coupon names or codes", async () => {
	const user = await seller(), sub = owned(user, { discounts: ["di_financial"] });
	fake.discounts.set("di_financial", { id: "di_financial", start: Math.floor(Date.now() / 1000) - 100, end: null, source: { type: "coupon", coupon: "coupon_financial" } });
	fake.coupons.set("coupon_financial", { id: "coupon_financial", duration: "forever", percent_off: 20, applies_to: null, currency_options: null, name: "PRIVATE_COUPON_NAME", metadata: { code: "DO_NOT_COPY_PROMO_CODE" } });
	await m.Contact.create({ accountId: user.accountId, newsletterId: user.newsletterId, email: "discount-reader@example.com", stripeSubscriptionId: sub.id });
	const output = await refresh(user); assert.equal(output.status, 200, JSON.stringify(output.body));
	const row = await m.Financial.findOne({ accountId: user.accountId }).lean(); assert.equal(row.state.monthlyRecurringMinor, 800); assert.doesNotMatch(JSON.stringify(row), /PRIVATE_COUPON|PROMO_CODE|coupon_financial/);
	assert.ok(fake.requests.some((request) => request.path.includes("/coupons/") && request.method === "GET"));
});

test("unknown snapshots and missing history remain unknown in reports and CSV rather than becoming zero revenue", async () => {
	const user = await seller(); const sub = owned(user); delete sub.items.data[0].price.unit_amount;
	await observe(user, sub);
	await m.Contact.create({ accountId: user.accountId, newsletterId: user.newsletterId, email: "missing-reader@example.com", stripeSubscriptionId: "sub_not_observed" });
	const output = (await report(user)).body; assert.equal(output.coverage.untrackedSubscriptions, 1); assert.equal(output.coverage.historicalComplete, false);
	assert.equal(output.currencies[0].monthlyRecurringMinor, null); assert.equal(output.currencies[0].knownMonthlyRecurringMinor, null); assert.equal(output.currencies[0].paidInvoiceMinor, null); assert.equal(output.trackedCohort.lossRate, null);
	const csv = await api(user, "GET", `/reports/revenue/export?newsletter=${user.slug}`); assert.equal(csv.status, 200); assert.match(csv.body.csv, /historicalComplete,false/); assert.doesNotMatch(csv.body.csv, /missing-reader@example/);
	assert.ok(m.purge.CONTENT_MODELS.includes(m.Financial)); assert.ok(m.purge.CONTENT_MODELS.includes(m.Change)); assert.ok(m.purge.CONTENT_MODELS.includes(m.Invoice));
});

test("financial report and refresh keep existing key presets and newsletter scope boundaries", async () => {
	const user = await seller(), other = await seller();
	const readKey = (await as(user, () => m.keys.createApiKey(null, form({ name: "Financial reader", level: "read_only", newsletter: user.newsletterId })))).key;
	assert.equal((await callApi("GET", `/api/v1/reports/revenue?newsletter=${user.slug}`, { key: readKey })).status, 200);
	assert.equal((await callApi("POST", "/api/v1/reports/revenue/refresh", { key: readKey, body: { newsletter: user.slug } })).status, 403);
	assert.equal((await callApi("GET", `/api/v1/reports/revenue?newsletter=${other.slug}`, { key: readKey })).status, 403);
	assert.equal((await report(other)).body.currencies.length, 0);
});

test("a tracked cancellation followed by reactivation is an event count but no ending cohort loss", async () => {
	const user = await seller(), sub = owned(user), now = new Date();
	await observe(user, sub, new Date(+now - 40 * DAY));
	await observe(user, { ...sub, status: "canceled" }, new Date(+now - 10 * DAY));
	await observe(user, sub, new Date(+now - 5 * DAY));
	const output = await m.reports.getSubscriptionRevenueReport({ account: user.account, newsletter: user.newsletter, now });
	assert.equal(output.observedChanges.churn, 1); assert.equal(output.observedChanges.reactivated, 1); assert.equal(output.trackedCohort.lossRate, 0);
	const upgraded = { ...sub, metadata: { ...sub.metadata, tierId: "plus" } };
	await observe(user, upgraded, new Date(+now - DAY));
	assert.equal((await m.reports.getSubscriptionRevenueReport({ account: user.account, newsletter: user.newsletter, now })).observedChanges.upgraded, 1);
});

test("an incomplete bounded scan leaves full totals and the cohort rate blank", async () => {
	const user = await seller();
	for (let index = 0; index < 3; index++) {
		const sub = owned(user); await observe(user, sub);
		await m.Contact.create({ accountId: user.accountId, newsletterId: user.newsletterId, email: `limit-${index}@example.com`, stripeSubscriptionId: sub.id });
		await m.observations.observeSubscriptionInvoice({ account: user.account, newsletter: user.newsletter, subscriptionId: sub.id, invoice: { id: `in_limit_${++sequence}`, subscription: sub.id, status: "paid", currency: "usd", amount_paid: 1000, status_transitions: { paid_at: Math.floor(Date.now() / 1000) } } });
	}
	const limits = m.rules.REVENUE_SCAN_LIMITS, before = { ...limits };
	Object.assign(limits, { subscriptions: 2, invoices: 2, changes: 2 });
	try {
		const output = (await report(user)).body; assert.equal(output.coverage.limited, true); assert.equal(output.coverage.untrackedSubscriptions, null);
		assert.equal(output.currencies[0].monthlyRecurringMinor, null); assert.equal(output.currencies[0].paidInvoiceMinor, null); assert.equal(output.currencies[0].knownMonthlyRecurringMinor, 2000); assert.equal(output.trackedCohort.lossRate, null);
	} finally { Object.assign(limits, before); }
});

test("refresh cursors cover more than one page and a zero paid invoice remains an observed zero", async () => {
	const user = await seller(); const rows = [];
	for (let index = 0; index < 22; index++) { const sub = owned(user); rows.push({ accountId: user.accountId, newsletterId: user.newsletterId, email: `paged-${index}@example.com`, stripeSubscriptionId: sub.id }); }
	await m.Contact.insertMany(rows);
	const first = await refresh(user); assert.equal(first.body.contactsScanned, 20); assert.ok(first.body.cursor);
	const second = await refresh(user, first.body.cursor); assert.equal(second.body.contactsScanned, 2); assert.equal(second.body.cursor, null);
	assert.equal(await m.Financial.countDocuments({ accountId: user.accountId }), 22);
	const sub = rows[0].stripeSubscriptionId;
	await m.observations.observeSubscriptionInvoice({ account: user.account, newsletter: user.newsletter, subscriptionId: sub, invoice: { id: `in_zero_${++sequence}`, parent: { subscription_details: { subscription: sub } }, status: "paid", currency: "usd", amount_paid: 0, status_transitions: { paid_at: Math.floor(Date.now() / 1000) } } });
	const output = (await report(user)).body; assert.equal(output.currencies[0].paidInvoiceMinor, 0); assert.equal(output.currencies[0].invoiceCount, 1);
});

test("financial captures stop for an account awaiting deletion even when a caller holds its older context", async () => {
	const user = await seller(), sub = owned(user);
	const Account = (await import("../models/Account.js")).default;
	await Account.updateOne({ _id: user.accountId }, { $set: { "deletion.requestedAt": new Date(), "deletion.purgeAt": new Date(Date.now() + DAY) } });
	assert.equal((await observe(user, sub)).recorded, false);
	const invoice = { id: `in_deleted_${++sequence}`, subscription: sub.id, status: "paid", currency: "usd", amount_paid: 1000, status_transitions: { paid_at: Math.floor(Date.now() / 1000) } };
	assert.equal((await m.observations.observeSubscriptionInvoice({ account: user.account, newsletter: user.newsletter, subscriptionId: sub.id, invoice })).recorded, false);
	assert.equal(await m.Financial.countDocuments({ accountId: user.accountId }), 0); assert.equal(await m.Invoice.countDocuments({ accountId: user.accountId }), 0);
});
