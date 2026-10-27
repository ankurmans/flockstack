import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { anonymous, startTestApp, withEnv } from "./helpers/app.mjs";
import { addTier, completeCheckout, setTier, subscribe } from "./helpers/paid.mjs";
import { WEBHOOK_SECRET, api, createSeller, installFakeStripe, postPaymentEvent } from "./helpers/shop.mjs";

let app;
let m;
let fake;
let n = 0;
before(async () => {
	app = await startTestApp({ STRIPE_PAYMENTS_WEBHOOK_SECRET: WEBHOOK_SECRET });
	m = {
		Account: (await import("../models/Account.js")).default,
		Offer: (await import("../models/Offer.js")).default,
		Contact: (await import("../models/Contact.js")).default,
		Newsletter: (await import("../models/Newsletter.js")).default,
		rules: await import("../lib/paid-trial-rules.js"),
		offers: await import("../lib/offers.js"),
		offerPage: (await import("../app/archive/[slug]/offer/[code]/page.js")).default,
		Form: (await import("../components/FormSubscribePaid.jsx")).default,
		Provider: (await import("../components/ProviderReaderLanguage.jsx")).default,
	};
});
beforeEach(() => { fake = installFakeStripe(); });
after(() => app?.stop());
async function seller(extra = {}) {
	const user = await createSeller(`trialfee${++n}@example.com`, { fake });
	await setTier(user, { trialDays: 7, trialNoCard: true, ...extra });
	return user;
}
async function makeOffer(user, extra = {}) {
	const response = await api(user, "POST", `/newsletters/${user.slug}/offers`, { name: "A paid trial", type: "trial", trialDays: 14, trialAmountCents: 100, ...extra });
	assert.equal(response.status, 201, JSON.stringify(response.body));
	return response.body;
}

test("paid-trial terms freeze currency, require ready payments/card/days and respect currency minimums", async () => {
	const user = await seller({ currency: "eur" });
	const offer = await makeOffer(user);
	assert.equal(offer.trialAmountCents, 100); assert.equal(offer.currency, "eur"); assert.equal(offer.trialNoCard, false);
	assert.equal(offer.stripeCouponId, null); assert.equal(fake.coupons.size, 0);
	for (const extra of [{ type: "percent", percentOff: 20 }, { trialNoCard: true }, { trialAmountCents: 99 }, { trialDays: undefined }]) {
		const response = await api(user, "POST", `/newsletters/${user.slug}/offers`, { name: `Invalid ${++n}`, type: "trial", trialDays: 14, trialAmountCents: 100, ...extra });
		assert.equal(response.status, 400, JSON.stringify(response.body));
	}
	await setTier(user, { currency: "nok" });
	assert.equal((await api(user, "POST", `/newsletters/${user.slug}/offers`, { name: "Too little", type: "trial", trialDays: 14, trialAmountCents: 100 })).status, 400);
	assert.equal((await makeOffer(user, { name: "NOK access", trialAmountCents: 300 })).currency, "nok");
	const unavailable = await seller();
	await m.Account.updateOne({ _id: unavailable.accountId }, { $set: { "payments.chargesEnabled": false } });
	assert.equal((await api(unavailable, "POST", `/newsletters/${unavailable.slug}/offers`, { name: "Not ready", type: "trial", trialDays: 7, trialAmountCents: 100 })).status, 409);
});

test("checkout adds one initial fee to a fixed recurring plan, ignores client fee changes and never takes an application fee", async () => {
	const user = await seller(); const offer = await makeOffer(user);
	const response = await subscribe(user, { offer: offer.code, trialAmountCents: 1, trialNoCard: true });
	assert.ok(response.url, JSON.stringify(response));
	const session = [...fake.sessions.values()].at(-1);
	assert.equal(session.connectedAccount, user.stripeAccountId);
	assert.equal(session.mode, "subscription"); assert.equal(session.line_items.length, 2);
	assert.ok(session.line_items[0].price);
	const fee = session.line_items[1].price_data;
	assert.equal(Number(fee.unit_amount), 100); assert.equal(fee.currency, "usd"); assert.equal(fee.recurring, undefined);
	assert.equal(Number(session.subscription_data.trial_period_days), 14);
	assert.equal(session.payment_method_collection, "always"); assert.deepEqual(session.payment_method_types, ["card"]);
	assert.equal(session.allow_promotion_codes, "false"); assert.equal(session.discounts, undefined);
	assert.equal(session.subscription_data.metadata.trialAmountCents, "100"); assert.equal(session.subscription_data.metadata.trialCurrency, "usd");
	assert.ok(!JSON.stringify(session).includes("application_fee"));
	assert.match(session.custom_text.submit.message, /Pay \$1\.00 now for 14 days/);
	await api(user, "PATCH", `/newsletters/${user.slug}/launch-banner`, { enabled: true, text: "A trial", offer: offer.id });
	await setTier(user, { currency: "eur" });
	assert.equal((await subscribe(user, { offer: offer.code })).error, "This offer has ended");
	assert.equal((await api(user, "GET", `/offers/${offer.id}`)).body.status, "ended");
	assert.equal(await m.offers.getLaunchBanner(await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean()), null);
});

test("invoice proof rejects unpaid, underpaid, wrong-currency and unrelated invoices, including changed provider shapes", () => {
	const subscription = { id: "sub_example", metadata: { trialAmountCents: "100", trialCurrency: "usd" } };
	const invoice = { id: "in_example", status: "paid", billing_reason: "subscription_create", subscription: subscription.id, currency: "usd", amount_paid: 100 };
	assert.equal(m.rules.hasPaidTrialInvoice(subscription, invoice), true);
	for (const patch of [{ status: "open" }, { amount_paid: 99 }, { currency: "eur" }, { subscription: "sub_other" }, { billing_reason: "subscription_cycle" }, { amount_paid: "100" }]) assert.equal(m.rules.hasPaidTrialInvoice(subscription, { ...invoice, ...patch }), false, JSON.stringify(patch));
	assert.equal(m.rules.hasPaidTrialInvoice(subscription, { ...invoice, subscription: undefined, parent: { subscription_details: { subscription: { id: subscription.id } } } }), true);
	assert.equal(m.rules.hasPaidTrialInvoice({ ...subscription, metadata: { trialAmountCents: "not-an-amount", trialCurrency: "usd" } }, invoice), false);
});

test("a trialing event does not grant access before the initial invoice is paid; payment then grants once until trial_end", async () => {
	const user = await seller(); const offer = await makeOffer(user);
	const answer = await subscribe(user, { offer: offer.code, email: "buyer@example.com" });
	const trialEnd = Math.floor(Date.now() / 1000) + 14 * 86400;
	const invoice = { id: "in_initial_trial", status: "open", billing_reason: "subscription_create", currency: "usd", amount_paid: 0 };
	fake.invoices.set(invoice.id, invoice);
	const checkout = await completeCheckout(fake, user, answer.url, { email: "buyer@example.com", status: "trialing", trial_end: trialEnd, latest_invoice: invoice.id });
	assert.equal(checkout.result.status, 200, JSON.stringify(checkout.result));
	invoice.subscription = checkout.subscription.id;
	assert.equal(await m.Contact.countDocuments({ accountId: user.accountId, email: "buyer@example.com" }), 0);
	const changed = fake.event("customer.subscription.updated", { ...checkout.subscription, status: "active" }, { account: user.stripeAccountId });
	assert.equal((await postPaymentEvent(changed)).status, 200);
	assert.equal(await m.Contact.countDocuments({ accountId: user.accountId, email: "buyer@example.com" }), 0, "current Stripe state and invoice override a stale event");
	Object.assign(invoice, { status: "paid", amount_paid: 100 });
	const paid = fake.event("invoice.paid", invoice, { account: user.stripeAccountId });
	assert.equal((await postPaymentEvent(paid)).status, 200);
	const contact = await m.Contact.findOne({ accountId: user.accountId, email: "buyer@example.com" }).lean();
	assert.equal(contact.tier, "paid"); assert.equal(contact.subscriptionStatus, "trialing");
	assert.equal(new Date(contact.paidUntil).getTime(), trialEnd * 1000);
	assert.equal(contact.offerId, offer.id);
	assert.equal((await postPaymentEvent(paid)).status, 200);
	assert.equal(await m.Contact.countDocuments({ accountId: user.accountId, email: "buyer@example.com" }), 1);
	assert.ok(fake.requests.filter((r) => r.path.startsWith("/v1/invoices/")).every((r) => r.account === user.stripeAccountId));
});

test("the reader sees the upfront amount and the recurring price, with a paid-trial button", () => {
	const tiers = [{ id: "paid", name: "Paid", benefits: [], founding: { enabled: false, spotsLeft: null }, options: [{ option: "month", cents: 800, label: "Monthly", note: "a month" }] }];
	const html = renderToStaticMarkup(createElement(m.Provider, { language: "en" }, createElement(m.Form, { newsletterSlug: "example", tiers, currency: "usd", trialDays: 14, offer: { code: "trial", type: "trial", trialAmountCents: 100 } })));
	assert.match(html, /Pay \$1\.00 now for 14 days of trial access, then \$8\.00 a month/);
	assert.match(html, /Renews until canceled/); assert.match(html, /Start trial for \$1\.00/); assert.ok(!html.includes("free trial"));
});

test("a paid-trial offer never charges a lifetime plan and omits it from the offer page", async () => {
	const user = await seller();
	const tier = await addTier(user, { name: "Forever", yearlyCents: 0, lifetimeCents: 5000 });
	const offer = await makeOffer(user);
	const before = fake.sessions.size;
	const refused = await subscribe(user, { offer: offer.code, tier: tier.id, option: "lifetime" });
	assert.match(refused.error, /fixed recurring plan/);
	assert.equal(fake.sessions.size, before);
	const html = renderToStaticMarkup(await anonymous(() => m.offerPage({ params: Promise.resolve({ slug: user.slug, code: offer.code }) })));
	assert.ok(!html.includes("Forever")); assert.ok(!html.includes("free trial"));
	assert.match(html, /upfront for 14 days/);
});

test("invalid persisted paid-trial terms cannot create a checkout, and the paid controls use the reader's language", async () => {
	const user = await seller(); const offer = await makeOffer(user);
	await m.Offer.updateOne({ accountId: user.accountId, _id: offer.id }, { $set: { trialDays: 0 } });
	const before = fake.sessions.size;
	assert.match((await subscribe(user, { offer: offer.code })).error, /terms are invalid/);
	assert.equal(fake.sessions.size, before);
	for (const patch of [{ type: "percent" }, { trialDays: 0 }, { trialNoCard: true }, { trialAmountCents: -1 }, { trialAmountCents: 1.5 }, { currency: "unknown" }]) assert.ok(m.rules.getPaidTrialProblem({ type: "trial", currency: "usd", trialDays: 14, trialAmountCents: 100, ...patch }));
	const tiers = [{ id: "paid", name: "Paid", benefits: [], founding: { enabled: false, spotsLeft: null }, options: [{ option: "month", cents: 800, label: "Monthly", note: "a month" }] }];
	const html = renderToStaticMarkup(createElement(m.Provider, { language: "es" }, createElement(m.Form, { newsletterSlug: "example", tiers, currency: "usd", trialDays: 14, offer: { code: "trial", type: "trial", trialAmountCents: 100 } })));
	assert.match(html, /Empezar prueba por/); assert.match(html, /Paga/); assert.ok(!html.includes("free trial"));
});

test("self-hosting opens the same trial on the owner's key without a connected-account header", async () => {
	const user = await seller(); const offer = await makeOffer(user);
	await withEnv({ FLOCKSTACK_CLOUD: "false" }, async () => {
		const answer = await subscribe(user, { offer: offer.code, email: "direct-trial@example.com" });
		assert.ok(answer.url, JSON.stringify(answer));
		const session = [...fake.sessions.values()].at(-1);
		assert.equal(session.connectedAccount, null);
		const customer = fake.addCustomer({ email: "direct-trial@example.com" });
		const subscription = fake.addSubscription({ status: "trialing", customer: customer.id, metadata: session.subscription_data.metadata, latest_invoice: "in_direct_trial", trial_end: Math.floor(Date.now() / 1000) + 14 * 86400 });
		fake.invoices.set("in_direct_trial", { id: "in_direct_trial", status: "paid", billing_reason: "subscription_create", subscription: subscription.id, currency: "usd", amount_paid: 100 });
		assert.equal((await postPaymentEvent(fake.event("customer.subscription.created", subscription))).status, 200);
		const contact = await m.Contact.findOne({ accountId: user.accountId, email: "direct-trial@example.com" }).lean();
		assert.equal(contact.tier, "paid");
		assert.equal(fake.requests.findLast((r) => r.path === "/v1/invoices/in_direct_trial").account, null);
	});
});
