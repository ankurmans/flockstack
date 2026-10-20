import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { anonymous, startTestApp } from "./helpers/app.mjs";
import { DAY, addReader, addTier, completeCheckout, listTiers, readerOf, sendIssue, setTier, skipJobs, subscribe, subscribeAndPay } from "./helpers/paid.mjs";
import { WEBHOOK_SECRET, api, assertError, createSeller, installFakeStripe, postPaymentEvent } from "./helpers/shop.mjs";
import { flushAfter } from "./stubs/next-server.mjs";
import { published } from "./stubs/qstash.mjs";

// Several paid tiers on a newsletter: their CRUD and order, the Stripe Products and Prices made on the creator's account,
// a newsletter from before tiers keeping its one tier, readers holding a tier, and paid issues for a tier or higher.
let app;
let m;
let fake;
let counter = 0;

const seller = (options = {}) => createSeller(`tiers${++counter}@example.com`, { fake, ...options });

async function render(page, params) {
	const element = await anonymous(() => page(params));
	return renderToStaticMarkup(createElement(m.ProviderSubscribe, { newsletter: { name: "Notes", slug: "notes" }, readers: 0 }, element));
}

before(async () => {
	app = await startTestApp({ STRIPE_PAYMENTS_WEBHOOK_SECRET: WEBHOOK_SECRET, QSTASH_CURRENT_SIGNING_KEY: "sig-current", QSTASH_NEXT_SIGNING_KEY: "sig-next" });
	m = {
		sendBatchRoute: await import("../app/api/jobs/send-batch/route.js"),
		subscribePage: (await import("../app/archive/[slug]/subscribe/page.js")).default,
		ProviderSubscribe: (await import("../components/ProviderSubscribe.jsx")).default,
		rules: await import("../lib/tier-rules.js"),
		webhooks: await import("../lib/webhooks.js"),
		Contact: (await import("../models/Contact.js")).default,
		Newsletter: (await import("../models/Newsletter.js")).default,
		Campaign: (await import("../models/Campaign.js")).default,
	};
});

after(() => app?.stop());

beforeEach(() => {
	fake = installFakeStripe();
});

describe("tier CRUD", () => {
	test("a newsletter has up to 3 tiers, lowest first, each with prices, benefits and a unique name", async () => {
		const user = await seller();
		await setTier(user, { monthlyCents: 0, yearlyCents: 0, enabled: false });
		const first = await addTier(user, { name: "Reader", description: "Every issue", benefits: ["All issues", "The archive"], monthlyCents: 500, quarterlyCents: 1400, yearlyCents: 5000, lifetimeCents: 15000 });
		assert.match(first.id, /^t_[a-z0-9]{6}$/);
		assert.deepEqual(
			[first.rank, first.name, first.monthlyCents, first.quarterlyCents, first.yearlyCents, first.lifetimeCents, first.benefits, first.offered, first.archived],
			[0, "Reader", 500, 1400, 5000, 15000, ["All issues", "The archive"], true, false]
		);
		const second = await addTier(user, { name: "Supporter", yearlyCents: 12000 });
		const third = await addTier(user, { name: "Patron", yearlyCents: 30000 });
		assert.deepEqual([second.rank, third.rank], [1, 2]);

		const tooMany = await api(user, "POST", `/newsletters/${user.slug}/tiers`, { name: "Fourth", monthlyCents: 100 });
		assert.match(assertError(tooMany, 409, "conflict"), /3 paid tiers at most/);
		const sameName = await api(user, "POST", `/newsletters/${user.slug}/tiers`, { name: "reader", monthlyCents: 100 });
		assertError(sameName, 409, "conflict");
		assert.deepEqual((await listTiers(user)).map(({ name }) => name), ["Reader", "Supporter", "Patron"]);
	});

	test("needs a price, and prices of at least the minimum", async () => {
		const user = await seller();
		assertError(await api(user, "POST", `/newsletters/${user.slug}/tiers`, { name: "Free" }), 400, "validation_failed");
		const cheap = await api(user, "POST", `/newsletters/${user.slug}/tiers`, { name: "Tiny", monthlyCents: 50 });
		assert.match(assertError(cheap, 400, "validation_failed"), /monthlyCents|at least 100/);
		const pwyw = await addTier(user, { name: "Name it", yearlyCents: undefined, payWhatYouWant: { minCents: 300, interval: "month" } });
		assert.deepEqual(pwyw.payWhatYouWant, { minCents: 300, interval: "month" });
	});

	test("update changes only what is sent, archive hides a tier from the subscribe page, and a price of 0 stops a plan", async () => {
		const user = await seller();
		await setTier(user, { monthlyCents: 0, yearlyCents: 0, enabled: false });
		const tier = await addTier(user, { name: "Reader", monthlyCents: 500, yearlyCents: 5000 });
		const other = await addTier(user, { name: "Supporter", yearlyCents: 12000 });
		const changed = await api(user, "PATCH", `/newsletters/${user.slug}/tiers/${tier.id}`, { yearlyCents: 4800, description: "Now with a discount" });
		assert.deepEqual([changed.body.monthlyCents, changed.body.yearlyCents, changed.body.description], [500, 4800, "Now with a discount"]);
		const noMonthly = await api(user, "PATCH", `/newsletters/${user.slug}/tiers/${tier.name}`, { monthlyCents: 0 });
		assert.deepEqual([noMonthly.body.monthlyCents, noMonthly.body.yearlyCents], [0, 4800], "found by name too");

		await setTier(user, { monthlyCents: undefined, yearlyCents: undefined });
		const archived = await api(user, "PATCH", `/newsletters/${user.slug}/tiers/${other.id}`, { archived: true });
		assert.deepEqual([archived.body.archived, archived.body.offered], [true, false]);
		const page = await render(m.subscribePage, { params: Promise.resolve({ slug: user.slug }) });
		assert.match(page, /Reader/);
		assert.doesNotMatch(page, /Supporter/, "an archived tier isn't offered");
		const last = await api(user, "PATCH", `/newsletters/${user.slug}/tiers/${tier.id}`, { archived: true });
		assert.match(assertError(last, 409, "conflict"), /turn it off first/, "the open paid tier keeps one tier to pick");
	});

	test("delete works for a tier nobody holds, and a held tier can only be archived", async () => {
		const user = await seller();
		await setTier(user, { monthlyCents: 0, yearlyCents: 0, enabled: false });
		const a = await addTier(user, { name: "Reader", monthlyCents: 500 });
		const b = await addTier(user, { name: "Supporter", yearlyCents: 12000 });
		await addReader(m, user, "holder@example.net", { tier: "paid", paidTierId: b.id, paidUntil: new Date(Date.now() + 20 * DAY * 1000) });

		assert.match(assertError(await api(user, "DELETE", `/newsletters/${user.slug}/tiers/${b.id}`), 409, "conflict"), /archive it instead/);
		const removed = await api(user, "DELETE", `/newsletters/${user.slug}/tiers/${a.id}`);
		assert.deepEqual(removed.body, { id: a.id, deleted: true });
		assert.deepEqual((await listTiers(user)).map(({ id }) => id), [b.id]);
		assertError(await api(user, "DELETE", `/newsletters/${user.slug}/tiers/nope`), 404, "not_found");
	});

	test("reorder sets which tier is above which, and needs every tier once", async () => {
		const user = await seller();
		await setTier(user, { monthlyCents: 0, yearlyCents: 0, enabled: false });
		const a = await addTier(user, { name: "Reader", monthlyCents: 500 });
		const b = await addTier(user, { name: "Supporter", yearlyCents: 12000 });
		assertError(await api(user, "POST", `/newsletters/${user.slug}/tiers/order`, { tierIds: [a.id] }), 400, "validation_failed");
		assertError(await api(user, "POST", `/newsletters/${user.slug}/tiers/order`, { tierIds: [a.id, a.id] }), 400, "validation_failed");
		const reordered = await api(user, "POST", `/newsletters/${user.slug}/tiers/order`, { tierIds: [b.id, a.id] });
		assert.deepEqual(reordered.body.tiers.map(({ name, rank }) => [name, rank]), [["Supporter", 0], ["Reader", 1]]);
	});

	test("belongs to the newsletter's account only", async () => {
		const owner = await seller();
		const stranger = await seller();
		await addTier(owner, { name: "Mine", monthlyCents: 500 });
		assertError(await api(stranger, "GET", `/newsletters/${owner.slug}/tiers`), 404, "not_found");
	});
});

describe("a newsletter from before tiers", () => {
	async function legacySeller() {
		const user = await seller();
		await setTier(user, { monthlyCents: 800, yearlyCents: 8000, pitch: "The deep dives." });
		const stored = await m.Newsletter.findOne({ accountId: user.accountId }).lean();
		assert.equal(stored.paidTiers, undefined, "nothing was written as tiers");
		return user;
	}

	test("has one tier named as today, with its old prices and no change to what it asks", async () => {
		const user = await legacySeller();
		const [tier] = await listTiers(user);
		assert.deepEqual([tier.id, tier.name, tier.monthlyCents, tier.yearlyCents, tier.rank, tier.offered], ["paid", "Paid subscription", 800, 8000, 0, true]);
		const paid = await api(user, "GET", `/newsletters/${user.slug}/paid-tier`);
		assert.deepEqual([paid.body.monthlyCents, paid.body.yearlyCents, paid.body.tierCount], [800, 8000, 1]);

		const answer = await subscribe(user, { option: "year" });
		assert.ok(answer.url);
		const session = [...fake.sessions.values()].at(-1);
		const price = fake.prices.get(session.line_items[0].price);
		assert.deepEqual([price.unit_amount, price.recurring.interval, price.currency], ["8000", "year", "usd"]);
		assert.equal(fake.products.get(price.product).name, `${user.slug} news, paid subscription`);
	});

	test("its paid readers hold that tier, and a subscription from before tiers keeps working", async () => {
		const user = await legacySeller();
		await addReader(m, user, "old@example.net", { tier: "paid", paidUntil: new Date(Date.now() + 20 * DAY * 1000), stripeCustomerId: "cus_old", stripeSubscriptionId: "sub_old" });
		assert.equal((await listTiers(user))[0].readers.paid, 1, "no tier id: it is the tier with none");

		const customer = fake.addCustomer({ email: "old@example.net" });
		const subscription = fake.addSubscription({ id: "sub_old", customer: customer.id, metadata: { flockstack: "1", kind: "paid_tier", accountId: String(user.accountId), newsletterId: user.newsletterId } });
		fake.subscriptions.set("sub_old", { ...subscription, id: "sub_old" });
		const renewed = await postPaymentEvent(fake.event("customer.subscription.updated", { id: "sub_old", object: "subscription" }, { account: user.stripeAccountId }));
		assert.deepEqual([renewed.body.tier, renewed.body.tierId], ["paid", "paid"]);
	});

	test("adding a tier writes the old one out as the lowest, and set_paid_tier's prices follow it", async () => {
		const user = await legacySeller();
		const supporter = await addTier(user, { name: "Supporter", yearlyCents: 12000 });
		assert.equal(supporter.rank, 1);
		const tiers = await listTiers(user);
		assert.deepEqual(tiers.map(({ id, name }) => [id, name]), [["paid", "Paid subscription"], [supporter.id, "Supporter"]]);

		const changed = await api(user, "PATCH", `/newsletters/${user.slug}/paid-tier`, { monthlyCents: 900 });
		assert.equal(changed.body.monthlyCents, 900);
		assert.equal((await listTiers(user))[0].monthlyCents, 900, "the lowest tier");
		assert.equal((await listTiers(user))[1].yearlyCents, 12000, "the others stay");
		const stored = await m.Newsletter.findOne({ accountId: user.accountId }).lean();
		assert.equal(stored.paidTier.monthlyCents, 900, "the older field follows");
	});
});

describe("the Stripe Products and Prices", () => {
	test("each tier is a Product on the creator's account with a Price for every way to pay", async () => {
		const user = await seller();
		await setTier(user, { monthlyCents: 0, yearlyCents: 0 }).catch(() => null);
		await setTier(user, { monthlyCents: 800, yearlyCents: 8000 });
		const tier = await addTier(user, {
			name: "Supporter",
			description: "Back the work",
			monthlyCents: 1000,
			quarterlyCents: 2700,
			yearlyCents: 10000,
			lifetimeCents: 30000,
			payWhatYouWant: { minCents: 500, interval: "year" },
		});
		assert.ok(tier.stripeProductId);
		const productCalls = fake.requests.filter(({ path }) => path === "/v1/products");
		assert.equal(productCalls.at(-1).account, user.stripeAccountId);
		assert.equal(productCalls.at(-1).params.name, `${user.slug} news, Supporter`);
		assert.equal(productCalls.at(-1).params.metadata.tierId, tier.id);

		const made = [...fake.prices.values()].filter((price) => price.product === tier.stripeProductId);
		const by = (option) => made.find((price) => price.metadata.option === option);
		assert.equal(made.length, 5);
		assert.deepEqual([by("month").unit_amount, by("month").recurring], ["1000", { interval: "month", interval_count: "1" }]);
		assert.deepEqual([by("quarter").unit_amount, by("quarter").recurring], ["2700", { interval: "month", interval_count: "3" }]);
		assert.deepEqual([by("year").unit_amount, by("year").recurring.interval], ["10000", "year"]);
		assert.deepEqual([by("lifetime").unit_amount, by("lifetime").recurring], ["30000", undefined], "one payment");
		assert.deepEqual(by("pwyw").custom_unit_amount, { enabled: "true", minimum: "500", preset: "500" });
		assert.equal(by("pwyw").unit_amount, undefined);
		for (const request of fake.requests.filter(({ path }) => path === "/v1/prices")) assert.equal(request.account, user.stripeAccountId);
		assert.doesNotMatch(JSON.stringify(fake.requests), /application_fee/i);
	});

	test("a changed price makes a new Price and retires the old one, and a repeat makes nothing", async () => {
		const user = await seller();
		await setTier(user);
		const tier = await addTier(user, { name: "Supporter", yearlyCents: 12000 });
		const count = () => fake.requests.filter(({ path }) => path === "/v1/prices").length;
		const before = count();
		await api(user, "PATCH", `/newsletters/${user.slug}/tiers/${tier.id}`, { description: "Only text changed" });
		assert.equal(count(), before, "no new Price for a new description");

		const old = [...fake.prices.values()].find((price) => price.product === tier.stripeProductId && price.metadata.option === "year");
		await api(user, "PATCH", `/newsletters/${user.slug}/tiers/${tier.id}`, { yearlyCents: 15000 });
		const current = [...fake.prices.values()].filter((price) => price.product === tier.stripeProductId && price.active);
		assert.deepEqual(current.map(({ unit_amount }) => unit_amount), ["15000"]);
		assert.equal(fake.prices.get(old.id).active, false, "readers already on it keep it, new ones can't pick it");

		await api(user, "PATCH", `/newsletters/${user.slug}/tiers/${tier.id}`, { yearlyCents: 0, monthlyCents: 1000 });
		assert.deepEqual([...fake.prices.values()].filter((price) => price.product === tier.stripeProductId && price.active).map(({ metadata }) => metadata.option), ["month"], "a plan no longer offered is retired");
	});

	test("nothing is made on Stripe until the paid tier is open, and turning it on makes everything", async () => {
		const user = await seller();
		const tier = await addTier(user, { name: "Reader", monthlyCents: 500 });
		assert.equal(tier.stripeProductId, null);
		assert.equal(fake.products.size, 0);
		await setTier(user, { monthlyCents: undefined, yearlyCents: undefined });
		assert.equal(fake.products.size, 1);
		assert.ok((await listTiers(user))[0].stripeProductId);
	});

	test("a Stripe that fails leaves the tier unsaved", async () => {
		const user = await seller();
		await setTier(user);
		fake.failNext("POST /v1/products");
		const failed = await api(user, "POST", `/newsletters/${user.slug}/tiers`, { name: "Supporter", yearlyCents: 12000 });
		assertError(failed, 503, "unavailable");
		assert.equal((await listTiers(user)).length, 1, "only the first tier");
	});

	test("deleting a tier retires its Product", async () => {
		const user = await seller();
		await setTier(user);
		const tier = await addTier(user, { name: "Supporter", yearlyCents: 12000 });
		await api(user, "DELETE", `/newsletters/${user.slug}/tiers/${tier.id}`);
		assert.equal(fake.products.get(tier.stripeProductId).active, false);
		assert.ok([...fake.prices.values()].filter((price) => price.product === tier.stripeProductId).every(({ active }) => !active));
	});
});

describe("subscribing to a tier", () => {
	test("the subscribe page lists the tiers with their benefits, and the form picks tier and plan", async () => {
		const user = await seller();
		await setTier(user);
		await addTier(user, { name: "Supporter", description: "Back the work", benefits: ["Your name on the wall"], yearlyCents: 12000, lifetimeCents: 40000 });
		const page = await render(m.subscribePage, { params: Promise.resolve({ slug: user.slug }) });
		assert.match(page, /Paid subscription/);
		assert.match(page, /Supporter/);
		assert.match(page, /Back the work/);

		const supporter = (await listTiers(user)).find(({ name }) => name === "Supporter");
		const answer = await subscribe(user, { tier: supporter.id, option: "lifetime" });
		const session = [...fake.sessions.values()].at(-1);
		assert.equal(answer.url, session.url);
		assert.equal(session.mode, "payment", "lifetime is one payment");
		assert.deepEqual(session.metadata, {
			flockstack: "1",
			kind: "paid_tier",
			accountId: String(user.accountId),
			newsletterId: String(user.newsletterId),
			tierId: supporter.id,
			option: "lifetime",
			interval: "lifetime",
		});
		assert.equal(session.subscription_data, undefined);
		assert.equal(session.payment_intent_data.metadata.tierId, supporter.id);
		assert.equal(fake.prices.get(session.line_items[0].price).unit_amount, "40000");
	});

	test("refuses a tier or plan the newsletter doesn't offer", async () => {
		const user = await seller();
		await setTier(user);
		const tier = await addTier(user, { name: "Supporter", yearlyCents: 12000 });
		const none = "This newsletter doesn't offer that plan";
		assert.deepEqual(await subscribe(user, { tier: tier.id, option: "month" }), { error: none }, "no monthly price");
		assert.deepEqual(await subscribe(user, { tier: "t_unknown", option: "year" }), { error: none });
		await api(user, "PATCH", `/newsletters/${user.slug}/tiers/${tier.id}`, { archived: true });
		assert.deepEqual(await subscribe(user, { tier: tier.id, option: "year" }), { error: none }, "archived");
	});

	test("a paying reader holds the tier they chose, and a quarterly plan is told apart from a monthly one", async () => {
		const user = await seller();
		await setTier(user);
		const tier = await addTier(user, { name: "Supporter", quarterlyCents: 2700, yearlyCents: 12000 });
		const { result } = await subscribeAndPay(fake, user, { tier: tier.id, option: "quarter", email: "quarter@example.net" }, { interval: "month", intervalCount: 3 });
		assert.deepEqual([result.body.tier, result.body.tierId], ["paid", tier.id]);
		const reader = await readerOf(m, user, "quarter@example.net");
		assert.deepEqual([reader.paidTierId, reader.paidInterval, reader.tier], [tier.id, "quarter", "paid"]);
		assert.equal((await listTiers(user)).find(({ id }) => id === tier.id).readers.paid, 1);
		assert.equal((await listTiers(user)).find(({ id }) => id === "paid").readers.paid, 0);
	});

	test("pay what you want checks out on the tier's custom amount Price", async () => {
		const user = await seller();
		await setTier(user);
		const tier = await addTier(user, { name: "Name it", yearlyCents: undefined, payWhatYouWant: { minCents: 500, interval: "month" } });
		await subscribe(user, { tier: tier.id, option: "pwyw" });
		const session = [...fake.sessions.values()].at(-1);
		const price = fake.prices.get(session.line_items[0].price);
		assert.deepEqual([price.custom_unit_amount.minimum, price.recurring.interval], ["500", "month"]);
		const { result } = await completeCheckout(fake, user, session.url, { email: "pwyw@example.net" });
		assert.equal(result.body.tierId, tier.id);
		assert.equal((await readerOf(m, user, "pwyw@example.net")).paidInterval, "month");
	});

	test("a lifetime reader is paid to the end of the century, and a full refund ends it", async () => {
		const user = await seller();
		await setTier(user);
		const tier = await addTier(user, { name: "Patron", lifetimeCents: 40000 });
		const { result } = await subscribeAndPay(fake, user, { tier: tier.id, option: "lifetime", email: "life@example.net" });
		assert.deepEqual([result.body.tier, result.body.tierId], ["paid", tier.id]);
		const reader = await readerOf(m, user, "life@example.net");
		assert.deepEqual([reader.tier, reader.paidInterval], ["paid", "lifetime"]);
		assert.ok(reader.paidUntil.getFullYear() >= 2099);
		assert.ok(reader.lifetimePaymentIntentId);

		const subscription = fake.addSubscription({ status: "canceled", metadata: {} });
		const stale = await postPaymentEvent(fake.event("customer.subscription.deleted", { id: subscription.id, object: "subscription", customer: "cus_x" }, { account: user.stripeAccountId }));
		assert.ok(stale.body.ignored, "an unrelated subscription ending changes nothing");

		const refund = await postPaymentEvent(fake.event("charge.refunded", { id: "ch_1", object: "charge", payment_intent: reader.lifetimePaymentIntentId, amount: 40000, amount_refunded: 40000, refunded: true }, { account: user.stripeAccountId }));
		assert.equal(refund.body.refunded, true);
		assert.equal((await readerOf(m, user, "life@example.net")).tier, "free");
	});

	test("a free trial that asks for no card says so to Stripe", async () => {
		const user = await seller();
		await setTier(user, { trialDays: 14, trialNoCard: true });
		await subscribe(user, { option: "month" });
		const session = [...fake.sessions.values()].at(-1);
		assert.equal(session.payment_method_collection, "if_required");
		assert.equal(session.subscription_data.trial_period_days, "14");
		assert.equal(session.subscription_data.trial_settings.end_behavior.missing_payment_method, "cancel");
		await setTier(user, { trialNoCard: false });
		await subscribe(user, { option: "month" });
		assert.equal([...fake.sessions.values()].at(-1).payment_method_collection, undefined);
	});
});

describe("a paid issue for a tier or higher", () => {
	async function threeTiers() {
		const user = await seller();
		await setTier(user);
		const supporter = await addTier(user, { name: "Supporter", yearlyCents: 12000 });
		const patron = await addTier(user, { name: "Patron", yearlyCents: 30000 });
		const until = new Date(Date.now() + 20 * DAY * 1000);
		await addReader(m, user, "legacy@example.net", { tier: "paid", paidUntil: until });
		await addReader(m, user, "supporter@example.net", { tier: "paid", paidUntil: until, paidTierId: supporter.id });
		await addReader(m, user, "patron@example.net", { tier: "paid", paidUntil: until, paidTierId: patron.id });
		await addReader(m, user, "free@example.net");
		skipJobs();
		return { user, supporter, patron };
	}

	const to = ({ emails }) => emails.map(({ to: address }) => address).sort();

	test("any paid tier reaches every paid reader", async () => {
		const { user } = await threeTiers();
		const sent = await sendIssue(m, user, { audience: "paid", subject: "For everyone paid" });
		assert.deepEqual(to(sent), ["legacy@example.net", "patron@example.net", "supporter@example.net"]);
		assert.equal(sent.campaign.paidTier, null);
	});

	test("a tier reaches its readers and every tier above it", async () => {
		const { user, supporter } = await threeTiers();
		const sent = await sendIssue(m, user, { audience: "paid", paidTier: supporter.id, subject: "Supporters and up" });
		assert.deepEqual(to(sent), ["patron@example.net", "supporter@example.net"]);
		assert.deepEqual(sent.campaign.paidTier, { id: supporter.id, name: "Supporter" });
	});

	test("the lowest tier, found by name, reaches the readers from before tiers too", async () => {
		const { user } = await threeTiers();
		const sent = await sendIssue(m, user, { audience: "paid", paidTier: "paid", subject: "All the tiers" });
		assert.deepEqual(to(sent), ["legacy@example.net", "patron@example.net", "supporter@example.net"]);
	});

	test("the top tier reaches only its own readers", async () => {
		const { user, patron } = await threeTiers();
		const sent = await sendIssue(m, user, { audience: "paid", paidTier: "patron", subject: "Patrons" });
		assert.deepEqual(to(sent), ["patron@example.net"]);
		assert.equal(sent.campaign.paidTier.id, patron.id);
	});

	test("the order decides: moving a tier up changes who an issue reaches", async () => {
		const { user, supporter, patron } = await threeTiers();
		await api(user, "POST", `/newsletters/${user.slug}/tiers/order`, { tierIds: ["paid", patron.id, supporter.id] });
		const sent = await sendIssue(m, user, { audience: "paid", paidTier: patron.id, subject: "Patron and up" });
		assert.deepEqual(to(sent), ["patron@example.net", "supporter@example.net"]);
	});

	test("audience counts follow the tier, and a send that picks another audience drops it", async () => {
		const { user, supporter } = await threeTiers();
		const created = await api(user, "POST", "/campaigns", { subject: "Counted", content: "Hi", audience: "paid", paidTier: supporter.id });
		const detail = await api(user, "GET", `/campaigns/${created.body.id}`);
		assert.equal(detail.body.audienceSize, 2);
		assert.equal(detail.body.paidTier.name, "Supporter");

		const wrong = await api(user, "PATCH", `/campaigns/${created.body.id}`, { paidTier: "Nobody" });
		assert.match(assertError(wrong, 400, "validation_failed"), /no paid tier/);
		const cleared = await api(user, "PATCH", `/campaigns/${created.body.id}`, { paidTier: null });
		assert.equal(cleared.body.paidTier, null);
		const back = await api(user, "PATCH", `/campaigns/${created.body.id}`, { paidTier: supporter.id });
		assert.equal(back.body.paidTier.id, supporter.id);
		const everyone = await api(user, "PATCH", `/campaigns/${created.body.id}`, { audience: "all" });
		assert.equal(everyone.body.paidTier, null, "a free or open issue is for no tier");
		const stored = await m.Campaign.findOne({ accountId: user.accountId, _id: created.body.id }).lean();
		assert.equal(stored.audienceTiers, undefined);
	});

	test("a reader whose tier no longer fits when the batch goes is skipped", async () => {
		const { user, supporter } = await threeTiers();
		await api(user, "POST", `/campaigns`, { subject: "Late", content: "Hi", audience: "paid", paidTier: supporter.id });
		const sent = await sendIssue(m, user, { audience: "paid", paidTier: supporter.id, subject: "Supporters" });
		assert.equal(sent.emails.length, 2);
		await m.Contact.updateOne({ accountId: user.accountId, email: "supporter@example.net" }, { $set: { paidTierId: "paid" } });
		const next = await sendIssue(m, user, { audience: "paid", paidTier: supporter.id, subject: "Again" });
		assert.deepEqual(to(next), ["patron@example.net"]);
	});
});

describe("the webhook events carry the tier", () => {
	function receiver() {
		const requests = [];
		return { requests, fetchImpl: async (url, init) => (requests.push(JSON.parse(init.body)), new Response("ok", { status: 200 })) };
	}

	test("subscriber.upgraded and subscriber.downgraded say which tier", async () => {
		const user = await seller();
		await setTier(user);
		const supporter = await addTier(user, { name: "Supporter", yearlyCents: 12000 });
		const endpoint = await api(user, "POST", "/webhooks", { url: "https://hooks.example.com/in", events: ["subscriber.upgraded", "subscriber.downgraded"] });
		assert.equal(endpoint.status, 201, JSON.stringify(endpoint.body));
		const before = published.length;
		const { subscription } = await subscribeAndPay(fake, user, { tier: supporter.id, option: "year", email: "hook@example.net" }, { interval: "year" });
		fake.subscriptions.set(subscription.id, { ...subscription, status: "canceled" });
		await postPaymentEvent(fake.event("customer.subscription.deleted", { id: subscription.id, object: "subscription" }, { account: user.stripeAccountId }));
		await flushAfter();

		const { requests, fetchImpl } = receiver();
		for (const { body } of published.slice(before).filter(({ url }) => url.endsWith("/api/jobs/deliver-webhook"))) await m.webhooks.deliverWebhook(body, { fetchImpl });
		assert.deepEqual(requests.map(({ type }) => type), ["subscriber.upgraded", "subscriber.downgraded"]);
		const [upgraded, downgraded] = requests;
		assert.deepEqual(upgraded.data.tier, { id: supporter.id, name: "Supporter" });
		assert.deepEqual([upgraded.data.subscriber.tier, upgraded.data.subscriber.paidTierId, upgraded.data.interval, upgraded.data.source], ["paid", supporter.id, "year", "stripe"]);
		assert.deepEqual(downgraded.data.tier, { id: supporter.id, name: "Supporter" });
		assert.deepEqual([downgraded.data.subscriber.tier, downgraded.data.subscriber.paidTierId], ["free", null]);
	});
});

describe("segments", () => {
	async function segmentSetup() {
		const user = await seller();
		await setTier(user);
		const supporter = await addTier(user, { name: "Supporter", yearlyCents: 12000 });
		const until = new Date(Date.now() + 20 * DAY * 1000);
		await addReader(m, user, "legacy@example.net", { tier: "paid", paidUntil: until });
		await addReader(m, user, "supporter@example.net", { tier: "paid", paidUntil: until, paidTierId: supporter.id });
		await addReader(m, user, "lapsed@example.net", { tier: "paid", paidUntil: new Date(Date.now() - 30 * DAY * 1000), paidTierId: supporter.id });
		await addReader(m, user, "free@example.net");
		return { user, supporter };
	}

	async function who(user, condition) {
		const response = await api(user, "POST", "/segments/preview", { rules: { match: "all", conditions: [condition] }, sample: 25 });
		assert.equal(response.status, 200, JSON.stringify(response.body));
		return response.body.sample.map(({ email }) => email.split("@")[0]).sort();
	}

	test("tier is a condition: free, any paid tier, or one tier", async () => {
		const { user, supporter } = await segmentSetup();
		assert.deepEqual(await who(user, { type: "tier", value: "free" }), ["free", "lapsed"], "a period that ran out is free");
		assert.deepEqual(await who(user, { type: "tier", value: "paid" }), ["legacy", "supporter"]);
		assert.deepEqual(await who(user, { type: "tier", value: supporter.id }), ["supporter"]);
		assert.deepEqual(await who(user, { type: "tier", value: "paid", op: "is" }), ["legacy", "supporter"]);
	});

	test("is_not works for a tier, and the tier from before tiers matches readers with no tier id", async () => {
		const { user, supporter } = await segmentSetup();
		assert.deepEqual(await who(user, { type: "tier", value: "paid", op: "is_not" }), ["free", "lapsed"]);
		assert.deepEqual(await who(user, { type: "tier", value: supporter.id, op: "is_not" }), ["free", "lapsed", "legacy"]);
		assert.deepEqual(await who(user, { type: "tier", value: "free", op: "is_not" }), ["legacy", "supporter"]);
	});

	test("a tier the newsletter doesn't have is refused, and the summary names the tier", async () => {
		const { user, supporter } = await segmentSetup();
		const missing = await api(user, "POST", "/segments", { name: "Nobody", rules: { match: "all", conditions: [{ type: "tier", value: "t_nothing" }] } });
		assert.match(assertError(missing, 400, "validation_failed"), /no paid tier/);
		const bad = await api(user, "POST", "/segments", { name: "Weird", rules: { match: "all", conditions: [{ type: "tier", value: "Not A Tier!" }] } });
		assertError(bad, 400, "validation_failed");
		const created = await api(user, "POST", "/segments", { name: "Supporters", rules: { match: "all", conditions: [{ type: "tier", value: supporter.id }] } });
		assert.equal(created.status, 201, JSON.stringify(created.body));
		assert.match(created.body.summary ?? JSON.stringify(created.body), /Supporter/);
	});

	test("a campaign can go to a segment of one tier", async () => {
		const { user, supporter } = await segmentSetup();
		const segment = await api(user, "POST", "/segments", { name: "Supporter readers", rules: { match: "all", conditions: [{ type: "tier", value: supporter.id }] } });
		skipJobs();
		const created = await api(user, "POST", "/campaigns", { subject: "To supporters", content: "Hi", segment: segment.body.id });
		const response = await api(user, "POST", `/campaigns/${created.body.id}/send`, {});
		assert.equal(response.status, 200, JSON.stringify(response.body));
	});
});
