import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { anonymous, jsonRequest, startTestApp } from "./helpers/app.mjs";
import { WEBHOOK_SECRET, api, assertError, createSeller, installFakeStripe, postPaymentEvent } from "./helpers/shop.mjs";
import { runWithRequest } from "./stubs/next-headers.mjs";
import { flushAfter } from "./stubs/next-server.mjs";
import { published } from "./stubs/qstash.mjs";
import { sent as emails } from "./stubs/ses.mjs";

// A newsletter's paid tier: readers subscribe through Stripe Checkout on the creator's account, the webhook keeps each
// contact's tier in step with their subscription, campaigns can go to free, paid or all readers, a paid issue is a teaser
// on the web and whole in the email, and paid readers manage billing from a link in every email.
let app;
let m;
let fake;
let processed = 0;

const DAY = 86_400;
const NOW = () => Math.floor(Date.now() / 1000);
let counter = 0;

async function seller(options = {}) {
	const user = await createSeller(`tier${++counter}@example.com`, { fake, ...options });
	return user;
}

async function setTier(user, fields = {}) {
	const response = await api(user, "PATCH", `/newsletters/${user.slug}/paid-tier`, { enabled: true, monthlyCents: 800, yearlyCents: 8000, ...fields });
	assert.equal(response.status, 200, JSON.stringify(response.body));
	return response.body;
}

async function addReader(user, email, fields = {}) {
	return m.Contact.create({ accountId: user.accountId, newsletterId: user.newsletterId, email, status: "active", subscribedAt: new Date(), ...fields });
}

const paidFields = (days = 20) => ({ tier: "paid", paidUntil: new Date(Date.now() + days * DAY * 1000), stripeCustomerId: `cus_${++counter}`, stripeSubscriptionId: `sub_${counter}` });

async function runJobs() {
	while (processed < published.length) {
		const { url, body } = published[processed++];
		if (url.endsWith("/api/jobs/send-batch")) await m.sendBatchRoute.POST(jsonRequest(url, { method: "POST", body }));
	}
}

async function sendIssue(user, { audience, content = "Hello readers.", subject = "Issue", ...send } = {}) {
	const created = await api(user, "POST", "/campaigns", { subject, previewText: "This week", content, ...(audience && { audience }) });
	assert.equal(created.status, 201, JSON.stringify(created.body));
	const before = emails.length;
	const response = await api(user, "POST", `/campaigns/${created.body.id}/send`, send);
	assert.equal(response.status, 200, JSON.stringify(response.body));
	await runJobs();
	return { id: created.body.id, emails: emails.slice(before), campaign: response.body };
}

// What the paid tier's own checkout form sends, from a visitor's network.
let visitors = 0;
async function subscribe(user, fields = {}, { ip = `192.0.2.${(++visitors % 250) + 1}` } = {}) {
	const actions = await import("../app/archive/shop-actions.js");
	const data = new FormData();
	for (const [key, value] of Object.entries({ newsletter: user.slug, interval: "month", email: "reader@example.net", ...fields })) data.set(key, String(value));
	return runWithRequest({ headers: { "x-forwarded-for": ip } }, () => actions.subscribePaid(null, data));
}

// A paid-tier Checkout Session the reader completed, and the subscription Stripe made for it.
async function completeSubscription(user, { email = "reader@example.net", interval = "month", status = "active", ...subscription } = {}) {
	const { url } = await subscribe(user, { email, interval });
	const session = [...fake.sessions.values()].find((candidate) => candidate.url === url);
	const customer = fake.addCustomer({ email });
	const created = fake.addSubscription({
		customer: customer.id,
		status,
		metadata: session.subscription_data.metadata,
		items: { data: [{ id: "si_1", price: { recurring: { interval } } }] },
		...subscription,
	});
	fake.paidSession(session.id, { mode: "subscription", subscription: created.id, customer: customer.id, customer_details: { email }, payment_status: "paid" });
	const event = fake.event("checkout.session.completed", session, { account: user.stripeAccountId });
	return { session, customer, subscription: created, event, result: await postPaymentEvent(event) };
}

async function readerOf(user, email) {
	return m.Contact.findOne({ accountId: user.accountId, email }).lean();
}

const send = (user, type, subscription) => postPaymentEvent(fake.event(type, subscription, { account: user.stripeAccountId }));

// The archive's layout wraps its pages in the subscribe popup's provider.
async function render(page, params) {
	const element = await anonymous(() => page(params));
	const pitch = { name: "Notes", slug: "notes" };
	return renderToStaticMarkup(createElement(m.ProviderSubscribe, { newsletter: pitch, readers: 0 }, element));
}

before(async () => {
	app = await startTestApp({ STRIPE_PAYMENTS_WEBHOOK_SECRET: WEBHOOK_SECRET, QSTASH_CURRENT_SIGNING_KEY: "sig-current", QSTASH_NEXT_SIGNING_KEY: "sig-next" });
	m = {
		sendBatchRoute: await import("../app/api/jobs/send-batch/route.js"),
		portalRoute: await import("../app/api/shop/portal/route.js"),
		issuePage: (await import("../app/archive/[slug]/p/[post]/page.js")).default,
		subscribePage: (await import("../app/archive/[slug]/subscribe/page.js")).default,
		shopPage: (await import("../app/archive/[slug]/shop/page.js")).default,
		archivePage: (await import("../app/archive/[slug]/page.js")).default,
		ProviderSubscribe: (await import("../components/ProviderSubscribe.jsx")).default,
		tiers: await import("../lib/tiers.js"),
		audience: await import("../lib/audience.js"),
		paywall: await import("../lib/paywall.js"),
		cleanup: await import("../lib/cleanup.js"),
		portalLink: await import("../lib/portal-link.js"),
		Account: (await import("../models/Account.js")).default,
		Campaign: (await import("../models/Campaign.js")).default,
		Contact: (await import("../models/Contact.js")).default,
		Message: (await import("../models/Message.js")).default,
		Newsletter: (await import("../models/Newsletter.js")).default,
	};
});

after(() => app?.stop());

beforeEach(() => {
	fake = installFakeStripe();
});

describe("the paid tier's settings", () => {
	test("turn on with a price and a Stripe account that takes payments, and read back", async () => {
		const user = await seller();
		const before = await api(user, "GET", `/newsletters/${user.slug}/paid-tier`);
		assert.deepEqual([before.body.enabled, before.body.monthlyCents, before.body.subscribeUrl, before.body.paidSubscribers], [false, 0, null, 0]);

		const tier = await setTier(user, { trialDays: 7, pitch: "Every issue, plus the deep dives.", currency: "eur" });
		assert.deepEqual(
			{ enabled: tier.enabled, monthly: tier.monthlyCents, yearly: tier.yearlyCents, currency: tier.currency, trial: tier.trialDays, url: tier.subscribeUrl },
			{ enabled: true, monthly: 800, yearly: 8000, currency: "eur", trial: 7, url: `https://${user.slug}.flockstackmail.com/subscribe` }
		);
		const changed = await api(user, "PATCH", `/newsletters/${user.id ?? user.newsletterId}/paid-tier`, { monthlyCents: 900 });
		assert.deepEqual([changed.body.monthlyCents, changed.body.yearlyCents, changed.body.trialDays], [900, 8000, 7], "the rest stays");
		const off = await api(user, "PATCH", `/newsletters/${user.slug}/paid-tier`, { enabled: false });
		assert.deepEqual([off.body.enabled, off.body.subscribeUrl, off.body.monthlyCents], [false, null, 900]);
	});

	test("need a price, a price over the minimum, and a connected Stripe account", async () => {
		const user = await seller();
		assert.match(assertError(await api(user, "PATCH", `/newsletters/${user.slug}/paid-tier`, { enabled: true }), 400, "validation_failed"), /set a monthly or a yearly price/);
		assert.match(assertError(await api(user, "PATCH", `/newsletters/${user.slug}/paid-tier`, { monthlyCents: 50 }), 400, "validation_failed"), /at least 100/);
		assertError(await api(user, "PATCH", `/newsletters/${user.slug}/paid-tier`, { monthlyCents: 800, trialDays: 400 }), 400, "validation_failed");
		assertError(await api(user, "PATCH", `/newsletters/${user.slug}/paid-tier`, { monthlyCents: 800, currency: "btc" }), 400, "validation_failed");

		const unconnected = await seller({ ready: false });
		assert.match(assertError(await api(unconnected, "PATCH", `/newsletters/${unconnected.slug}/paid-tier`, { enabled: true, monthlyCents: 800 }), 409, "payments_not_ready"), /Connect your Stripe account/);
		const saved = await api(unconnected, "PATCH", `/newsletters/${unconnected.slug}/paid-tier`, { monthlyCents: 800 });
		assert.equal(saved.body.enabled, false, "prices can be set before Stripe is connected");
	});

	test("belong to their account", async () => {
		const owner = await seller();
		const stranger = await seller();
		await setTier(owner);
		assertError(await api(stranger, "GET", `/newsletters/${owner.slug}/paid-tier`), 404, "not_found");
		assertError(await api(stranger, "PATCH", `/newsletters/${owner.slug}/paid-tier`, { enabled: false }), 404, "not_found");
		assert.equal((await m.Newsletter.findOne({ accountId: owner.accountId }).lean()).paidTier.enabled, true);
	});

	test("don't change a newsletter's settings form: saving it keeps the tier", async () => {
		const user = await seller();
		await setTier(user);
		const response = await api(user, "PATCH", `/newsletters/${user.slug}`, { description: "A new description" });
		assert.equal(response.status, 200);
		assert.equal((await m.Newsletter.findOne({ accountId: user.accountId }).lean()).paidTier.monthlyCents, 800);
	});
});

describe("subscribing", () => {
	test("opens a subscription Checkout Session on the creator's account at the tier's price, with no application fee", async () => {
		const user = await seller();
		await setTier(user, { trialDays: 7 });
		const answer = await subscribe(user, { interval: "year", email: "Reader@Example.net", price: "1", unit_amount: "1" });
		assert.match(answer.url, /^https:\/\/checkout\.stripe\.test\/c\/pay\//);

		const request = fake.requests.find(({ path }) => path === "/v1/checkout/sessions");
		assert.equal(request.account, user.stripeAccountId);
		const { params } = request;
		assert.equal(params.mode, "subscription");
		assert.deepEqual(params.line_items[0].price_data.recurring, { interval: "year" });
		assert.equal(params.line_items[0].price_data.unit_amount, "8000", "the tier's price, not the form's");
		assert.equal(params.line_items[0].price_data.currency, "usd");
		assert.equal(params.customer_email, "reader@example.net");
		assert.equal(params.subscription_data.trial_period_days, "7");
		assert.deepEqual(params.subscription_data.metadata, params.metadata);
		assert.deepEqual(params.metadata, {
			flockstack: "1",
			kind: "paid_tier",
			accountId: String(user.accountId),
			newsletterId: String(user.newsletterId),
			interval: "year",
		});
		assert.equal(params.success_url, `https://${user.slug}.flockstackmail.com/subscribe?paid=1`);
		assert.equal(params.cancel_url, `https://${user.slug}.flockstackmail.com/subscribe`);
		assert.doesNotMatch(JSON.stringify(request), /application_fee/i, "no cut, on subscriptions either");
	});

	test("refuses what the tier doesn't offer", async () => {
		const user = await seller();
		assert.deepEqual(await subscribe(user), { error: "This newsletter doesn't offer that plan" }, "tier off");
		await setTier(user, { yearlyCents: 0 });
		assert.deepEqual(await subscribe(user, { interval: "year" }), { error: "This newsletter doesn't offer that plan" });
		assert.deepEqual(await subscribe(user, { interval: "weekly" }), { error: "Pick monthly or yearly" });
		assert.deepEqual(await subscribe(user, { email: "nope" }), { error: "Enter a valid email" });
		assert.deepEqual(await subscribe(user, { website: "bot" }), { error: "This newsletter doesn't offer that plan" });
		assert.deepEqual(await subscribe({ slug: "no-such-shop" }), { error: "This newsletter doesn't offer that plan" });
		await addReader(user, "member@example.net", paidFields());
		assert.match((await subscribe(user, { email: "member@example.net" })).error, /already a paid subscriber/);
		await m.Contact.updateOne({ accountId: user.accountId, email: "member@example.net" }, { $set: { paidUntil: new Date(Date.now() - 30 * DAY * 1000) } });
		assert.ok((await subscribe(user, { email: "member@example.net" })).url, "a lapsed subscriber can subscribe again");

		await m.Account.updateOne({ _id: user.accountId }, { $set: { "payments.chargesEnabled": false } });
		assert.deepEqual(await subscribe(user), { error: "Payments aren't open for this newsletter yet" });
	});

	test("is limited for one network", async () => {
		const user = await seller();
		await setTier(user);
		const results = [];
		for (let count = 0; count < 21; count++) results.push(await subscribe(user, {}, { ip: "198.51.100.200" }));
		assert.equal(results.filter(({ url }) => url).length, 20);
		assert.match(results.at(-1).error, /Too many attempts/);
	});

	test("has a page with the plans, and a link from the shop", async () => {
		const user = await seller();
		const params = { params: Promise.resolve({ slug: user.slug }) };
		assert.equal((await anonymous(() => m.subscribePage(params)).catch((error) => error.message)), "NEXT_NOT_FOUND", "no page while the tier is off");
		await setTier(user, { trialDays: 14, pitch: "The deep dives, first." });
		const page = await render(m.subscribePage, params);
		assert.match(page, /Become a paid subscriber/);
		assert.match(page, /The deep dives, first\./);
		assert.match(page, /\$8\.00/);
		assert.match(page, /\$80\.00/);
		assert.match(page, /Start your 14-day free trial/);
		const shop = await render(m.shopPage, params);
		assert.match(shop, new RegExp(`href="https://${user.slug}\\.flockstackmail\\.com/subscribe"`), "a shop with only the paid tier");
	});
});

describe("the webhook keeps each contact's tier in step with Stripe", () => {
	test("a new subscriber becomes a paid, active contact without a confirmation email, and a repeat does nothing", async () => {
		const user = await seller({ requireConfirmation: true });
		await setTier(user);
		const { event, subscription, result } = await completeSubscription(user, { email: "New.Reader@Example.net", interval: "year" });
		assert.deepEqual([result.status, result.body.handled, result.body.tier], [200, "checkout.session.completed", "paid"]);

		const contact = await readerOf(user, "new.reader@example.net");
		assert.deepEqual([contact.status, contact.source, contact.tier, contact.paidInterval, contact.subscriptionStatus], ["active", "paid", "paid", "year", "active"]);
		assert.equal(contact.stripeSubscriptionId, subscription.id);
		assert.equal(contact.paidUntil.getTime(), subscription.current_period_end * 1000);
		assert.ok(contact.paidSince);
		await flushAfter();

		const repeat = await postPaymentEvent(event);
		assert.equal(repeat.body.duplicate, true);
		assert.equal(await m.Contact.countDocuments({ accountId: user.accountId, email: "new.reader@example.net" }), 1);
	});

	test("an existing free contact is upgraded, not duplicated, and a reader who had unsubscribed is back", async () => {
		const user = await seller();
		await setTier(user);
		await addReader(user, "free@example.net");
		await addReader(user, "gone@example.net", { status: "unsubscribed" });
		await completeSubscription(user, { email: "free@example.net" });
		await completeSubscription(user, { email: "gone@example.net" });
		assert.equal(await m.Contact.countDocuments({ accountId: user.accountId, email: "free@example.net" }), 1);
		assert.deepEqual([(await readerOf(user, "free@example.net")).tier, (await readerOf(user, "free@example.net")).status], ["paid", "active"]);
		assert.deepEqual([(await readerOf(user, "gone@example.net")).tier, (await readerOf(user, "gone@example.net")).status], ["paid", "active"], "paying is signing up again");
	});

	test("a bounced address stays out of the list even when it pays", async () => {
		const user = await seller();
		await setTier(user);
		await addReader(user, "bounced@example.net", { status: "bounced" });
		await completeSubscription(user, { email: "bounced@example.net" });
		const contact = await readerOf(user, "bounced@example.net");
		assert.deepEqual([contact.status, contact.tier], ["bounced", "paid"]);
	});

	test("renewal extends the period, a failed payment drops the reader to free, a recovered one brings them back", async () => {
		const user = await seller();
		await setTier(user);
		const { subscription } = await completeSubscription(user, { email: "renewing@example.net" });
		const first = (await readerOf(user, "renewing@example.net")).paidUntil.getTime();

		fake.subscriptions.set(subscription.id, { ...subscription, current_period_end: subscription.current_period_end + 30 * DAY });
		assert.equal((await send(user, "invoice.paid", { id: "in_1", object: "invoice", subscription: subscription.id })).body.tier, "paid");
		assert.equal((await readerOf(user, "renewing@example.net")).paidUntil.getTime(), first + 30 * DAY * 1000, "renewed");

		fake.subscriptions.set(subscription.id, { ...fake.subscriptions.get(subscription.id), status: "past_due" });
		const failed = await send(user, "invoice.payment_failed", { id: "in_2", object: "invoice", parent: { subscription_details: { subscription: subscription.id } } });
		assert.equal(failed.body.tier, "free");
		const dropped = await readerOf(user, "renewing@example.net");
		assert.deepEqual([dropped.tier, dropped.subscriptionStatus], ["free", "past_due"]);

		fake.subscriptions.set(subscription.id, { ...fake.subscriptions.get(subscription.id), status: "active" });
		await send(user, "customer.subscription.updated", { id: subscription.id, object: "subscription" });
		assert.equal((await readerOf(user, "renewing@example.net")).tier, "paid");
	});

	test("cancelling keeps the reader paid to the end of the period, and the end makes them free", async () => {
		const user = await seller();
		await setTier(user);
		const { subscription } = await completeSubscription(user, { email: "leaving@example.net" });

		fake.subscriptions.set(subscription.id, { ...subscription, cancel_at_period_end: true });
		await send(user, "customer.subscription.updated", { id: subscription.id });
		assert.equal((await readerOf(user, "leaving@example.net")).tier, "paid", "paid until the period ends");

		fake.subscriptions.set(subscription.id, { ...subscription, status: "canceled" });
		const ended = await send(user, "customer.subscription.deleted", { id: subscription.id });
		assert.equal(ended.body.tier, "free");
		assert.equal((await readerOf(user, "leaving@example.net")).tier, "free");
		assert.equal((await readerOf(user, "leaving@example.net")).status, "active", "still on the free list");
	});

	test("a trial counts as paid, and an incomplete payment does not", async () => {
		const user = await seller();
		await setTier(user, { trialDays: 7 });
		await completeSubscription(user, { email: "trial@example.net", status: "trialing" });
		await completeSubscription(user, { email: "incomplete@example.net", status: "incomplete" });
		assert.equal((await readerOf(user, "trial@example.net")).tier, "paid");
		assert.equal((await readerOf(user, "incomplete@example.net")).tier, "free");
	});

	test("reads Stripe's latest state, so a late event can't bring back what was cancelled", async () => {
		const user = await seller();
		await setTier(user);
		const { subscription } = await completeSubscription(user, { email: "late@example.net" });
		fake.subscriptions.set(subscription.id, { ...subscription, status: "canceled" });
		// "updated (active)" arrives after Stripe cancelled it.
		await send(user, "customer.subscription.updated", { ...subscription, status: "active" });
		assert.equal((await readerOf(user, "late@example.net")).tier, "free");
	});

	test("reads the period from the subscription's items, as newer Stripe versions send it", async () => {
		const user = await seller();
		await setTier(user);
		const periodEnd = NOW() + 12 * DAY;
		await completeSubscription(user, {
			email: "items@example.net",
			current_period_end: undefined,
			items: { data: [{ id: "si_9", current_period_end: periodEnd, price: { recurring: { interval: "month" } } }] },
		});
		assert.equal((await readerOf(user, "items@example.net")).paidUntil.getTime(), periodEnd * 1000);
	});

	test("a reader's older subscription ending doesn't undo the newer one", async () => {
		const user = await seller();
		await setTier(user);
		const first = await completeSubscription(user, { email: "twice@example.net" });
		// The reader starts another subscription (from a link of an old email, say), on the same Stripe customer.
		const second = { subscription: fake.addSubscription({ customer: first.customer.id, metadata: first.subscription.metadata }) };
		await send(user, "customer.subscription.created", { id: second.subscription.id });
		assert.notEqual(second.subscription.id, first.subscription.id);
		fake.subscriptions.set(first.subscription.id, { ...first.subscription, status: "canceled" });
		const ignored = await send(user, "customer.subscription.deleted", { id: first.subscription.id });
		assert.match(ignored.body.ignored, /another subscription/);
		const contact = await readerOf(user, "twice@example.net");
		assert.deepEqual([contact.tier, contact.stripeSubscriptionId], ["paid", second.subscription.id]);
	});

	test("ignores the creator's other subscriptions and other accounts' subscriptions", async () => {
		const user = await seller();
		await setTier(user);
		const other = fake.addSubscription({ metadata: {} });
		assert.match((await send(user, "customer.subscription.created", { id: other.id })).body.ignored, /not a FlockStack subscription/);
		const foreign = fake.addSubscription({ metadata: { flockstack: "1", kind: "paid_tier", accountId: "6a0000000000000000000003", newsletterId: String(user.newsletterId) } });
		assert.match((await send(user, "customer.subscription.created", { id: foreign.id })).body.ignored, /another account/);
		assert.equal(await m.Contact.countDocuments({ accountId: user.accountId }), 0);
	});
});

describe("who an issue goes to", () => {
	test("the audience query picks free, paid or everyone, and a lapsed paid reader counts as free", () => {
		const now = Date.parse("2026-10-18T12:00:00Z");
		const day = DAY * 1000;
		const readers = [
			{ _id: "free", email: "free@example.net", status: "active" },
			{ _id: "paid", email: "paid@example.net", status: "active", tier: "paid", paidUntil: new Date(now + 5 * day) },
			{ _id: "grace", email: "grace@example.net", status: "active", tier: "paid", paidUntil: new Date(now - 2 * day) },
			{ _id: "lapsed", email: "lapsed@example.net", status: "active", tier: "paid", paidUntil: new Date(now - 4 * day) },
			{ _id: "undated", email: "undated@example.net", status: "active", tier: "paid" },
			{ _id: "gone", email: "gone@example.net", status: "unsubscribed", tier: "paid", paidUntil: new Date(now + 5 * day) },
		];
		const ids = (audience) => m.audience.selectAudience(readers, { audience, now }).map(({ _id }) => _id).sort();
		assert.deepEqual(ids("all"), ["free", "grace", "lapsed", "paid", "undated"]);
		assert.deepEqual(ids("paid"), ["grace", "paid"], "three days of grace after the period");
		assert.deepEqual(ids("free"), ["free", "lapsed", "undated"]);
		assert.deepEqual(m.audience.buildAudienceQuery({ accountId: "a", newsletterId: "n", audience: "all", now }).filter, { accountId: "a", newsletterId: "n", status: "active" });
		assert.equal(m.audience.buildAudienceQuery({ accountId: "a", newsletterId: "n", audience: "paid", now }).filter.tier, "paid");
	});

	test("a paid issue is sent to paid readers only, a free one to free readers, the default to all", async () => {
		const user = await seller();
		await setTier(user);
		await addReader(user, "free1@example.net");
		await addReader(user, "free2@example.net");
		await addReader(user, "paid1@example.net", paidFields());
		await addReader(user, "paid2@example.net", paidFields());
		await addReader(user, "lapsed@example.net", { ...paidFields(), paidUntil: new Date(Date.now() - 10 * DAY * 1000) });
		await addReader(user, "pending@example.net", { ...paidFields(), status: "pending" });
		await addReader(user, "unsub@example.net", { ...paidFields(), status: "unsubscribed" });

		const paid = await sendIssue(user, { audience: "paid", subject: "Paid issue" });
		assert.deepEqual(paid.emails.map(({ to }) => to).sort(), ["paid1@example.net", "paid2@example.net"]);
		assert.equal(paid.campaign.audience, "paid");
		assert.equal(paid.campaign.stats.recipients, 2);

		const free = await sendIssue(user, { audience: "free", subject: "Free issue" });
		assert.deepEqual(free.emails.map(({ to }) => to).sort(), ["free1@example.net", "free2@example.net", "lapsed@example.net"]);

		const everyone = await sendIssue(user, { subject: "Everyone issue" });
		assert.equal(everyone.emails.length, 5);
		assert.equal(everyone.campaign.audience, "all");
	});

	test("the audience can be chosen when sending, and sticks to the campaign", async () => {
		const user = await seller();
		await setTier(user);
		await addReader(user, "free@example.net");
		await addReader(user, "paid@example.net", paidFields());
		const created = await api(user, "POST", "/campaigns", { subject: "Chosen at send", content: "Hello." });
		assert.equal(created.body.audience, "all");
		const detail = await api(user, "GET", `/campaigns/${created.body.id}`);
		assert.deepEqual([detail.body.activeContacts, detail.body.paidContacts], [2, 1]);

		const before = emails.length;
		const sent = await api(user, "POST", `/campaigns/${created.body.id}/send`, { audience: "paid" });
		assert.equal(sent.body.audience, "paid");
		await runJobs();
		assert.deepEqual(emails.slice(before).map(({ to }) => to), ["paid@example.net"]);
		assert.equal((await api(user, "GET", `/campaigns/${created.body.id}`)).body.audience, "paid");
	});

	test("scheduling counts the audience it was given, and keeps it", async () => {
		const user = await seller();
		await setTier(user);
		await addReader(user, "free@example.net");
		await addReader(user, "paid@example.net", paidFields());
		await m.Account.updateOne({ _id: user.accountId }, { $set: { limitOverrides: { emailsPerMonth: 1, subscribers: 100 } } });
		const created = await api(user, "POST", "/campaigns", { subject: "Later", content: "Hello." });
		const at = new Date(Date.now() + 3_600_000).toISOString();
		assertError(await api(user, "POST", `/campaigns/${created.body.id}/schedule`, { scheduledAt: at }), 402, "plan_limit_emails");
		const scheduled = await api(user, "POST", `/campaigns/${created.body.id}/schedule`, { scheduledAt: at, audience: "paid" });
		assert.equal(scheduled.status, 200, "one paid reader fits the month's one email");
		assert.deepEqual([scheduled.body.status, scheduled.body.audience], ["scheduled", "paid"]);
	});

	test("free and paid need the paid tier on", async () => {
		const user = await seller();
		assert.match(assertError(await api(user, "POST", "/campaigns", { subject: "No tier", audience: "paid" }), 400, "validation_failed"), /paid tier/);
		const created = await api(user, "POST", "/campaigns", { subject: "No tier", content: "Hello." });
		await addReader(user, "reader@example.net");
		assert.match(assertError(await api(user, "PATCH", `/campaigns/${created.body.id}`, { audience: "free" }), 400, "validation_failed"), /paid tier/);
		assert.match(assertError(await api(user, "POST", `/campaigns/${created.body.id}/send`, { audience: "paid" }), 400, "validation_failed"), /paid tier/);
		assert.equal((await api(user, "PATCH", `/campaigns/${created.body.id}`, { audience: "all" })).status, 200);
		await setTier(user);
		assert.equal((await api(user, "PATCH", `/campaigns/${created.body.id}`, { audience: "paid" })).body.audience, "paid");
	});

	test("a reader whose subscription ended after the issue was queued doesn't get the paid issue", async () => {
		const user = await seller();
		await setTier(user);
		await addReader(user, "stays@example.net", paidFields());
		await addReader(user, "leaves@example.net", paidFields());
		const created = await api(user, "POST", "/campaigns", { subject: "Queued paid", content: "Hello.", audience: "paid" });
		const before = emails.length;
		await api(user, "POST", `/campaigns/${created.body.id}/send`);
		await m.Contact.updateOne({ accountId: user.accountId, email: "leaves@example.net" }, { $set: { tier: "free" } });
		await runJobs();
		assert.deepEqual(emails.slice(before).map(({ to }) => to), ["stays@example.net"]);
		const skipped = await m.Message.findOne({ accountId: user.accountId, email: "leaves@example.net", kind: "campaign" }).lean();
		assert.deepEqual([skipped.status, skipped.error], ["skipped", "No longer a paid subscriber"]);
	});

	test("the list cleanup never sets a paying reader aside", () => {
		const settings = { enabled: true, issues: 2, days: 30 };
		const cold = { ignoredIssues: 10, lastEngagedAt: new Date("2025-01-01"), subscribedAt: new Date("2025-01-01") };
		const now = Date.parse("2026-10-18T12:00:00Z");
		assert.equal(m.cleanup.getCleanupAction(cold, settings, now), "lastChance");
		assert.equal(m.cleanup.getCleanupAction({ ...cold, tier: "paid", paidUntil: new Date(now + 10 * DAY * 1000) }, settings, now), "issue");
		assert.equal(m.cleanup.getCleanupAction({ ...cold, tier: "paid", paidUntil: new Date(now - 10 * DAY * 1000) }, settings, now), "lastChance", "until their period runs out");
	});
});

describe("a paid issue on the web", () => {
	const body = ["<p>The opening paragraph, free for everyone to read.</p>", "<p>A second paragraph that goes on for a while to show that the teaser stops somewhere around here.</p>", "<p>Third paragraph: the secret deep dive only paid readers get.</p>", '<p><img src="https://example.com/secret.png" alt=""></p>', "<script>alert(1)</script>"].join("");

	async function publish(user, { audience }) {
		await addReader(user, "reader@example.net", paidFields());
		const created = await api(user, "POST", "/campaigns", { subject: audience === "paid" ? "A paid issue" : "A free issue", previewText: "Preview line", format: "rich", content: body, ...(audience && { audience }) });
		const sentIssue = await api(user, "POST", `/campaigns/${created.body.id}/send`);
		await runJobs();
		const campaign = await m.Campaign.findOne({ accountId: user.accountId, _id: created.body.id }).lean();
		assert.equal(sentIssue.status, 200);
		return campaign;
	}

	const issueParams = (user, post) => ({ params: Promise.resolve({ slug: user.slug, post }) });

	test("shows a teaser and the way to subscribe, and none of the rest", async () => {
		const user = await seller();
		await setTier(user);
		const campaign = await publish(user, { audience: "paid" });
		const page = await render(m.issuePage, issueParams(user, campaign.archiveSlug));
		assert.match(page, /The opening paragraph, free for everyone to read\./);
		assert.match(page, /This issue is for paid subscribers/);
		assert.match(page, new RegExp(`href="https://${user.slug}\\.flockstackmail\\.com/subscribe"`));
		assert.doesNotMatch(page, /secret deep dive/);
		assert.doesNotMatch(page, /secret\.png/);
		assert.doesNotMatch(page, /alert\(1\)/);
		assert.match(page, /isAccessibleForFree/, "search engines are told it's paywalled");
	});

	test("shows a free issue whole", async () => {
		const user = await seller();
		await setTier(user);
		const campaign = await publish(user, { audience: "all" });
		const page = await render(m.issuePage, issueParams(user, campaign.archiveSlug));
		assert.match(page, /secret deep dive/);
		assert.doesNotMatch(page, /This issue is for paid subscribers/);
		assert.doesNotMatch(page, /isAccessibleForFree/);
	});

	test("says there is nothing to subscribe to when the tier is off, and marks the issue on the archive", async () => {
		const user = await seller();
		await setTier(user);
		const campaign = await publish(user, { audience: "paid" });
		await api(user, "PATCH", `/newsletters/${user.slug}/paid-tier`, { enabled: false });
		const page = await render(m.issuePage, issueParams(user, campaign.archiveSlug));
		assert.match(page, /This issue is for paid subscribers/);
		assert.doesNotMatch(page, /Become a paid subscriber/);
		assert.match(await render(m.archivePage, { params: Promise.resolve({ slug: user.slug }) }), />Paid</, "a badge on its card");
	});

	test("the issue's picture isn't used as its card", async () => {
		const user = await seller();
		await setTier(user);
		const campaign = await publish(user, { audience: "paid" });
		assert.ok(campaign.thumbnailUrl, "the issue has a picture of its own");
		const home = await render(m.archivePage, { params: Promise.resolve({ slug: user.slug }) });
		assert.doesNotMatch(home, /secret\.png/);
	});

	test("the teaser is plain, escaped text cut at a word", () => {
		const teaser = m.paywall.makeTeaser({ format: "rich", html: `<p>First &amp; <b>bold</b> sentence.</p><p>${"word ".repeat(200)}</p><p>Never shown.</p>` });
		assert.match(teaser, /^<p>First &amp; bold sentence\.<\/p><p>word word/);
		assert.match(teaser, /…<\/p>$/);
		assert.doesNotMatch(teaser, /Never shown|<b>/);
		assert.ok(teaser.length < 700);
		const markdown = m.paywall.makeTeaser({ format: "markdown", markdown: "# A title\n\nHello **there** <script>x</script>, welcome to the issue where we look at one thing in depth.\n\nAnd a second paragraph with more words to read, enough to make the issue longer than a handful of lines.\n\n![pic](https://example.com/p.png)" });
		assert.doesNotMatch(markdown, /<script>|p\.png|<img/);
		assert.match(markdown, /Hello there/);
		assert.match(m.paywall.makeTeaser({ format: "html", html: "<html><body><style>p{}</style><table><tr><td>Designed email text that opens the issue.</td></tr><tr><td>And a second row that carries on for long enough that the whole issue is more than a few words.</td></tr></table></body></html>" }), /Designed email text/);
	});
});

describe("the emails", () => {
	test("a paid issue's email has the whole text, no Read online link, and a manage link for paid readers only", async () => {
		const user = await seller();
		await setTier(user);
		await addReader(user, "paid@example.net", paidFields());
		await addReader(user, "free@example.net");
		const paid = await sendIssue(user, { audience: "paid", content: "Free opening.\n\nThe secret deep dive." });
		assert.equal(paid.emails.length, 1);
		const [email] = paid.emails;
		assert.match(email.html, /The secret deep dive\./);
		assert.doesNotMatch(email.html, /Read online/, "its web page is only a teaser");
		const link = /href="(https:\/\/[^"]+\/api\/shop\/portal\?token=[^"]+)"/.exec(email.html)?.[1];
		assert.ok(link, "a manage link");
		assert.match(email.html, /Manage your subscription/);
		assert.match(email.text, /Manage your subscription: https:\/\/\S+\/api\/shop\/portal\?token=/);
		assert.match(email.html, /Unsubscribe/, "and still the unsubscribe link");

		const everyone = await sendIssue(user, { subject: "For all", content: "Hello all." });
		const toFree = everyone.emails.find(({ to }) => to === "free@example.net");
		const toPaid = everyone.emails.find(({ to }) => to === "paid@example.net");
		assert.doesNotMatch(toFree.html, /Manage your subscription/);
		assert.match(toPaid.html, /Manage your subscription/);
		assert.match(toPaid.html, /Read online/, "an issue for everyone keeps its web page");
	});

	test("the manage link opens the reader's Stripe billing page on the creator's account", async () => {
		const user = await seller();
		await setTier(user);
		const contact = await addReader(user, "member@example.net", paidFields());
		const url = m.portalLink.getPortalUrl({ contactId: contact._id, newsletterId: user.newsletterId }, `https://${user.slug}.flockstackmail.com`);
		const open = (target) => anonymous(() => m.portalRoute.GET(new Request(target)));

		const response = await open(url);
		assert.equal(response.status, 302);
		assert.equal(response.headers.get("location"), `https://billing.stripe.test/p/session/${contact.stripeCustomerId}`);
		const created = fake.requests.find(({ path }) => path === "/v1/billing_portal/sessions");
		assert.equal(created.account, user.stripeAccountId);
		assert.equal(created.params.customer, contact.stripeCustomerId);
		assert.equal(created.params.return_url, `https://${user.slug}.flockstackmail.com/subscribe`);
		const configuration = fake.requests.find(({ method, path }) => method === "POST" && path === "/v1/billing_portal/configurations");
		assert.ok(configuration, "the portal is set up for the creator's account the first time");
		assert.equal(configuration.params.features.subscription_cancel.enabled, "true");
		assert.equal(response.headers.get("cache-control"), "private, no-store");

		await open(url);
		assert.equal(fake.requests.filter(({ method, path }) => method === "POST" && path === "/v1/billing_portal/configurations").length, 1, "set up once");
	});

	test("the manage link refuses links that are forged, old, or for nobody with a subscription", async () => {
		const user = await seller();
		await setTier(user);
		const member = await addReader(user, "member@example.net", paidFields());
		const free = await addReader(user, "free@example.net");
		const base = `https://${user.slug}.flockstackmail.com`;
		const open = (target) => anonymous(() => m.portalRoute.GET(new Request(target)));

		const forged = m.portalLink.getPortalUrl({ contactId: member._id, newsletterId: user.newsletterId }, base).replace(/.$/, "A");
		assert.equal((await open(forged)).status, 410);
		assert.equal((await open(`${base}/api/shop/portal?token=garbage`)).status, 410);
		assert.equal((await open(`${base}/api/shop/portal`)).status, 410);
		const old = m.portalLink.getPortalUrl({ contactId: member._id, newsletterId: user.newsletterId }, base, Date.now() - 500 * 86_400_000);
		assert.equal((await open(old)).status, 410, "after 400 days");
		const noSubscription = await open(m.portalLink.getPortalUrl({ contactId: free._id, newsletterId: user.newsletterId }, base));
		assert.equal(noSubscription.status, 410);
		assert.match(await noSubscription.text(), /no subscription to manage/);
		assert.equal(fake.requests.filter(({ path }) => path === "/v1/billing_portal/sessions").length, 0);

		fake.failNext("POST /v1/billing_portal/sessions");
		const down = await open(m.portalLink.getPortalUrl({ contactId: member._id, newsletterId: user.newsletterId }, base));
		assert.equal(down.status, 410);
		assert.match(await down.text(), /isn.t available right now/);
	});
});

describe("contacts", () => {
	test("show their tier, and the list filters by it", async () => {
		const user = await seller();
		await setTier(user);
		await addReader(user, "free@example.net");
		await addReader(user, "paid@example.net", paidFields());
		await addReader(user, "lapsed@example.net", { ...paidFields(), paidUntil: new Date(Date.now() - 10 * DAY * 1000) });
		const all = await api(user, "GET", "/contacts");
		const byEmail = Object.fromEntries(all.body.contacts.map((contact) => [contact.email, contact]));
		assert.deepEqual([byEmail["free@example.net"].tier, byEmail["paid@example.net"].tier, byEmail["lapsed@example.net"].tier], ["free", "paid", "free"]);
		assert.equal(byEmail["free@example.net"].paidUntil, null);
		assert.ok(byEmail["paid@example.net"].paidUntil);
		assert.deepEqual((await api(user, "GET", "/contacts?tier=paid")).body.contacts.map(({ email }) => email), ["paid@example.net"]);
		assert.deepEqual((await api(user, "GET", "/contacts?tier=free&limit=1")).body.contacts.length, 1);
		const page = await api(user, "GET", "/contacts?tier=free&limit=1");
		const next = await api(user, "GET", `/contacts?tier=free&limit=1&cursor=${page.body.nextCursor}`);
		assert.notEqual(next.body.contacts[0].email, page.body.contacts[0].email, "paging works with the filter");
		assert.equal((await api(user, "GET", `/newsletters/${user.slug}/paid-tier`)).body.paidSubscribers, 1);
	});
});
