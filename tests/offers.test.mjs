import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { anonymous, startTestApp } from "./helpers/app.mjs";
import { DAY, addReader, addTier, completeCheckout, listTiers, readerOf, setTier, subscribe } from "./helpers/paid.mjs";
import { WEBHOOK_SECRET, api, assertError, createSeller, installFakeStripe, postPaymentEvent } from "./helpers/shop.mjs";

// Offers: coupons made in FlockStack as Stripe coupons on the creator's account, links that apply them and show the
// discounted price, trials of their own, the launch banner, and a count of who took each one.
let app;
let m;
let fake;
let counter = 0;

const seller = (options = {}) => createSeller(`offers${++counter}@example.com`, { fake, ...options });

async function offerSeller() {
	const user = await seller();
	await setTier(user);
	return user;
}

async function makeOffer(user, fields = {}) {
	const response = await api(user, "POST", `/newsletters/${user.slug}/offers`, { name: "Launch week", type: "percent", percentOff: 25, ...fields });
	assert.equal(response.status, 201, JSON.stringify(response.body));
	return response.body;
}

async function render(page, user, extra = {}) {
	const element = await anonymous(() => page({ params: Promise.resolve({ slug: user.slug, ...extra }) }));
	return renderToStaticMarkup(createElement(m.ProviderSubscribe, { newsletter: { name: "Notes", slug: "notes" }, readers: 0 }, element));
}

const lastSession = () => [...fake.sessions.values()].at(-1);

before(async () => {
	app = await startTestApp({ STRIPE_PAYMENTS_WEBHOOK_SECRET: WEBHOOK_SECRET, QSTASH_CURRENT_SIGNING_KEY: "sig-current", QSTASH_NEXT_SIGNING_KEY: "sig-next" });
	m = {
		offerPage: (await import("../app/archive/[slug]/offer/[code]/page.js")).default,
		layout: (await import("../app/archive/[slug]/layout.js")).default,
		subscribeAction: await import("../app/archive/shop-actions.js"),
		ProviderSubscribe: (await import("../components/ProviderSubscribe.jsx")).default,
		rules: await import("../lib/offer-rules.js"),
		proxy: (await import("../proxy.js")).proxy,
		NextRequest: (await import("next/server")).NextRequest,
		Contact: (await import("../models/Contact.js")).default,
		Offer: (await import("../models/Offer.js")).default,
	};
});

after(() => app?.stop());

beforeEach(() => {
	fake = installFakeStripe();
});

describe("making an offer", () => {
	test("a percent offer is a coupon on the creator's Stripe account, with a link", async () => {
		const user = await offerSeller();
		const offer = await makeOffer(user, { duration: "repeating", durationMonths: 3, maxRedemptions: 50, expiresAt: new Date(Date.now() + 30 * DAY * 1000).toISOString() });
		assert.equal(offer.code, "launch-week", "made from the name");
		assert.equal(offer.url, `https://${user.slug}.flockstackmail.com/offer/launch-week`);
		assert.equal(offer.summary, "25% off for 3 months");
		assert.deepEqual([offer.type, offer.percentOff, offer.duration, offer.durationMonths, offer.maxRedemptions, offer.status, offer.redemptions], ["percent", 25, "repeating", 3, 50, "live", 0]);

		const coupon = fake.coupons.get(offer.stripeCouponId);
		assert.equal(coupon.connectedAccount, user.stripeAccountId);
		assert.deepEqual([coupon.percent_off, coupon.duration, coupon.duration_in_months, coupon.max_redemptions, coupon.name], ["25", "repeating", "3", "50", "Launch week"]);
		assert.ok(Number(coupon.redeem_by) > Date.now() / 1000);
		assert.doesNotMatch(JSON.stringify(fake.requests), /application_fee/i);
	});

	test("a fixed amount offer is in the newsletter's currency, and a trial offer makes no coupon", async () => {
		const user = await offerSeller();
		const amount = await makeOffer(user, { name: "Five off", type: "amount", amountOffCents: 500, duration: "forever", percentOff: undefined });
		assert.deepEqual([amount.summary, amount.currency], ["$5.00 off every payment", "usd"]);
		const coupon = fake.coupons.get(amount.stripeCouponId);
		assert.deepEqual([coupon.amount_off, coupon.currency, coupon.duration], ["500", "usd", "forever"]);

		const trial = await makeOffer(user, { name: "Try it", type: "trial", trialDays: 30, percentOff: undefined });
		assert.deepEqual([trial.summary, trial.stripeCouponId, trial.trialDays], ["A 30-day free trial", null, 30]);
		assert.equal(fake.coupons.size, 1);
	});

	test("checks its terms, its code and the number of offers", async () => {
		const user = await offerSeller();
		const post = (body) => api(user, "POST", `/newsletters/${user.slug}/offers`, body);
		assert.match(assertError(await post({ name: "Some offer", type: "percent" }), 400, "validation_failed"), /percentOff/);
		assert.match(assertError(await post({ name: "Some offer", type: "amount" }), 400, "validation_failed"), /amountOffCents/);
		assert.match(assertError(await post({ name: "Some offer", type: "trial" }), 400, "validation_failed"), /trialDays/);
		assert.match(assertError(await post({ name: "Some offer", type: "percent", percentOff: 10, duration: "repeating" }), 400, "validation_failed"), /durationMonths/);
		assertError(await post({ name: "Some offer", type: "percent", percentOff: 101 }), 400, "validation_failed");
		assert.match(assertError(await post({ name: "Some offer", type: "percent", percentOff: 10, expiresAt: "2020-01-01T00:00:00Z" }), 400, "validation_failed"), /future/);
		assert.match(assertError(await post({ name: "X", type: "percent", percentOff: 10, code: "Bad Code!" }), 400, "validation_failed"), /code/);
		assert.match(assertError(await post({ name: "Some offer", type: "percent", percentOff: 10, tiers: ["Nobody"] }), 400, "validation_failed"), /no paid tier/);
		await makeOffer(user, { name: "Same", code: "same" });
		assertError(await post({ name: "Same again", type: "percent", percentOff: 10, code: "same" }), 409, "conflict");
	});

	test("a Stripe that refuses or fails leaves no offer behind", async () => {
		const user = await offerSeller();
		fake.failNext("POST /v1/coupons");
		assertError(await api(user, "POST", `/newsletters/${user.slug}/offers`, { name: "Down", type: "percent", percentOff: 10 }), 503, "unavailable");
		assert.equal((await api(user, "GET", `/newsletters/${user.slug}/offers`)).body.offers.length, 0);
		const unready = await seller({ ready: false });
		await setTier(unready, { enabled: false });
		assertError(await api(unready, "POST", `/newsletters/${unready.slug}/offers`, { name: "No Stripe", type: "percent", percentOff: 10 }), 409, "payments_not_ready");
		const trial = await api(unready, "POST", `/newsletters/${unready.slug}/offers`, { name: "Trial", type: "trial", trialDays: 7 });
		assert.equal(trial.status, 201, "a trial needs no Stripe");
	});

	test("belongs to the newsletter's account only", async () => {
		const user = await offerSeller();
		const offer = await makeOffer(user);
		const stranger = await seller();
		assertError(await api(stranger, "GET", `/offers/${offer.id}`), 404, "not_found");
		assertError(await api(stranger, "DELETE", `/offers/${offer.id}`), 404, "not_found");
		assertError(await api(stranger, "GET", `/newsletters/${user.slug}/offers`), 404, "not_found");
	});
});

describe("the offer link", () => {
	test("the offer's address is routed to its page on the newsletter's host", async () => {
		const user = await offerSeller();
		const rewrite = async (path) => {
			const response = await m.proxy(new m.NextRequest(new URL(`https://${user.slug}.flockstackmail.com${path}`), { headers: { host: `${user.slug}.flockstackmail.com` } }));
			return response.headers.get("x-middleware-rewrite");
		};
		assert.match(await rewrite("/offer/launch-week"), new RegExp(`/archive/${user.slug}/offer/launch-week$`));
		assert.equal(await rewrite("/offer/x"), null, "a code of 3 to 40 characters");
	});

	test("shows the discounted price beside the regular one, and the offer in words", async () => {
		const user = await offerSeller();
		await makeOffer(user, { percentOff: 25, duration: "once" });
		const page = await render(m.offerPage, user, { code: "launch-week" });
		assert.match(page, /25% off the first payment/);
		assert.match(page, /<s[^>]*>\$8\.00<\/s> \$6\.00/);
		assert.match(page, /<s[^>]*>\$80\.00<\/s> \$60\.00/);
		assert.match(page, /name="offer" value="launch-week"/);
		assert.match(page, new RegExp(`${user.slug}`));
	});

	test("an amount offer takes its amount off, never below nothing", () => {
		assert.equal(m.rules.applyOffer(800, { type: "amount", amountOffCents: 500 }), 300);
		assert.equal(m.rules.applyOffer(400, { type: "amount", amountOffCents: 500 }), 0);
		assert.equal(m.rules.applyOffer(800, { type: "percent", percentOff: 33 }), 536);
		assert.equal(m.rules.applyOffer(800, { type: "trial" }), 800);
		assert.equal(m.rules.applyOffer(800, null), 800);
	});

	test("says so when the offer ended, was switched off or was used up, and offers the regular prices", async () => {
		const user = await offerSeller();
		const offer = await makeOffer(user, { maxRedemptions: 1 });
		await api(user, "PATCH", `/offers/${offer.id}`, { active: false });
		assert.match(await render(m.offerPage, user, { code: "launch-week" }), /This offer has ended/);
		await api(user, "PATCH", `/offers/${offer.id}`, { active: true });
		await addReader(m, user, "taker@example.net", { tier: "paid", paidUntil: new Date(Date.now() + 20 * DAY * 1000), offerId: offer.id });
		const used = await render(m.offerPage, user, { code: "launch-week" });
		assert.match(used, /taken up as many times as it goes/);
		assert.doesNotMatch(used, /name="offer" value="launch-week"/, "no discount is applied");
		assert.equal((await api(user, "GET", `/offers/${offer.id}`)).body.status, "used_up");

		const timed = await makeOffer(user, { name: "Timed", expiresAt: new Date(Date.now() + 60_000).toISOString() });
		await m.Offer.updateOne({ accountId: user.accountId, _id: timed.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
		assert.equal((await api(user, "GET", `/offers/${timed.id}`)).body.status, "ended");
		assert.match(await render(m.offerPage, user, { code: "timed" }), /This offer has ended/);
	});

	test("is a missing page for an unknown code or a newsletter without its paid tier", async () => {
		const user = await offerSeller();
		await makeOffer(user);
		assert.equal(await render(m.offerPage, user, { code: "nothing-here" }).catch((error) => error.message), "NEXT_NOT_FOUND");
		await api(user, "PATCH", `/newsletters/${user.slug}/paid-tier`, { enabled: false });
		assert.equal(await render(m.offerPage, user, { code: "launch-week" }).catch((error) => error.message), "NEXT_NOT_FOUND");
	});

	test("an offer for one tier shows only that tier", async () => {
		const user = await offerSeller();
		await addTier(user, { name: "Supporter", yearlyCents: 12000 });
		await makeOffer(user, { tiers: ["Supporter"] });
		const page = await render(m.offerPage, user, { code: "launch-week" });
		assert.match(page, /Supporter/);
		assert.doesNotMatch(page, /Paid subscription/);
	});
});

describe("checking out with an offer", () => {
	test("opens Checkout with the coupon on, in place of the promotion code box, and says which offer", async () => {
		const user = await offerSeller();
		const offer = await makeOffer(user);
		const answer = await subscribe(user, { option: "year", offer: "launch-week" });
		assert.ok(answer.url);
		const session = lastSession();
		assert.deepEqual(session.discounts, [{ coupon: offer.stripeCouponId }]);
		assert.equal(session.allow_promotion_codes, undefined, "Stripe takes a coupon or the box, not both");
		assert.equal(session.metadata.offerId, offer.id);
		assert.equal(session.subscription_data.metadata.offerId, offer.id);
		assert.equal(session.connectedAccount, user.stripeAccountId);

		await subscribe(user, { option: "year" });
		assert.equal(lastSession().allow_promotion_codes, "true");
		assert.equal(lastSession().discounts, undefined);
	});

	test("a lifetime payment takes the coupon too", async () => {
		const user = await offerSeller();
		const tier = await addTier(user, { name: "Patron", lifetimeCents: 30000 });
		const offer = await makeOffer(user);
		await subscribe(user, { tier: tier.id, option: "lifetime", offer: "launch-week" });
		assert.equal(lastSession().mode, "payment");
		assert.deepEqual(lastSession().discounts, [{ coupon: offer.stripeCouponId }]);
	});

	test("refuses an offer that is off, ended, used up, for another tier, in another currency or unknown", async () => {
		const user = await offerSeller();
		const supporter = await addTier(user, { name: "Supporter", yearlyCents: 12000 });
		const offer = await makeOffer(user, { tiers: [supporter.id] });
		assert.deepEqual(await subscribe(user, { option: "month", offer: "launch-week" }), { error: "This offer is for another tier" });
		assert.ok((await subscribe(user, { tier: supporter.id, option: "year", offer: "launch-week" })).url);
		assert.deepEqual(await subscribe(user, { tier: supporter.id, option: "year", offer: "no-such" }), { error: "This offer doesn't exist" });
		await api(user, "PATCH", `/offers/${offer.id}`, { active: false });
		assert.deepEqual(await subscribe(user, { tier: supporter.id, option: "year", offer: "launch-week" }), { error: "This offer has ended" });

		const amount = await makeOffer(user, { name: "Amount", type: "amount", amountOffCents: 300, percentOff: undefined });
		assert.ok((await subscribe(user, { option: "month", offer: "amount" })).url);
		await setTier(user, { currency: "eur" });
		assert.deepEqual(await subscribe(user, { option: "month", offer: "amount" }), { error: "This offer has ended" });
		void amount;
	});

	test("Stripe's own limit is the last word on a coupon that ran out", async () => {
		const user = await offerSeller();
		const offer = await makeOffer(user, { maxRedemptions: 2 });
		fake.coupons.get(offer.stripeCouponId).times_redeemed = 2;
		assert.deepEqual(await subscribe(user, { option: "month", offer: "launch-week" }), { error: "This offer has ended" });
	});
});

describe("trials", () => {
	test("an offer gives its link a trial of its own, with or without a card", async () => {
		const user = await offerSeller();
		await setTier(user, { trialDays: 7 });
		await makeOffer(user, { name: "Long trial", type: "trial", trialDays: 30, trialNoCard: true, percentOff: undefined });
		await subscribe(user, { option: "month", offer: "long-trial" });
		const session = lastSession();
		assert.equal(session.subscription_data.trial_period_days, "30");
		assert.equal(session.payment_method_collection, "if_required");
		assert.equal(session.subscription_data.trial_settings.end_behavior.missing_payment_method, "cancel");
		assert.equal(session.discounts, undefined, "a trial is not a discount");

		await subscribe(user, { option: "month" });
		assert.equal(lastSession().subscription_data.trial_period_days, "7", "the newsletter's own trial");
		assert.equal(lastSession().payment_method_collection, undefined, "asks for a card");
	});

	test("a discount can come with a trial, and the page says so", async () => {
		const user = await offerSeller();
		await makeOffer(user, { name: "Both", trialDays: 14, percentOff: 50 });
		const page = await render(m.offerPage, user, { code: "both" });
		assert.match(page, /50% off the first payment, with a 14-day free trial/);
		assert.match(page, /Start your 14-day free trial/);
		await subscribe(user, { option: "month", offer: "both" });
		assert.equal(lastSession().subscription_data.trial_period_days, "14");
		assert.ok(lastSession().discounts);
	});

	test("a trial without a card ends in a dropped reader when no card was added", async () => {
		const user = await offerSeller();
		await setTier(user, { trialDays: 14, trialNoCard: true });
		const { subscription } = await completeCheckout(fake, user, (await subscribe(user, { option: "month", email: "trial@example.net" })).url, { email: "trial@example.net", status: "trialing" });
		assert.equal((await readerOf(m, user, "trial@example.net")).tier, "paid", "a trial counts as paid");
		fake.subscriptions.set(subscription.id, { ...subscription, status: "canceled" });
		await postPaymentEvent(fake.event("customer.subscription.deleted", { id: subscription.id, object: "subscription" }, { account: user.stripeAccountId }));
		assert.equal((await readerOf(m, user, "trial@example.net")).tier, "free");
	});
});

describe("who took an offer", () => {
	test("counts the readers who signed up through it, who is paid now, and lists them", async () => {
		const user = await offerSeller();
		const offer = await makeOffer(user, { maxRedemptions: 3 });
		const first = await completeCheckout(fake, user, (await subscribe(user, { option: "month", email: "one@example.net", offer: "launch-week" })).url, { email: "one@example.net" });
		await completeCheckout(fake, user, (await subscribe(user, { option: "year", email: "two@example.net", offer: "launch-week" })).url, { email: "two@example.net", interval: "year" });
		await completeCheckout(fake, user, (await subscribe(user, { option: "month", email: "plain@example.net" })).url, { email: "plain@example.net" });
		assert.equal((await readerOf(m, user, "one@example.net")).offerId, offer.id);
		assert.equal((await readerOf(m, user, "plain@example.net")).offerId, undefined);

		const { body } = await api(user, "GET", `/offers/launch-week`);
		assert.deepEqual([body.redemptions, body.payingNow, body.status], [2, 2, "live"]);
		assert.deepEqual(body.redeemers.map(({ email }) => email).sort(), ["one@example.net", "two@example.net"]);
		assert.ok(body.redeemers.every(({ paidNow }) => paidNow));

		fake.subscriptions.set(first.subscription.id, { ...first.subscription, status: "canceled" });
		await postPaymentEvent(fake.event("customer.subscription.deleted", { id: first.subscription.id, object: "subscription" }, { account: user.stripeAccountId }));
		const after = (await api(user, "GET", `/newsletters/${user.slug}/offers`)).body.offers[0];
		assert.deepEqual([after.redemptions, after.payingNow], [2, 1], "taken by two, one still pays");
		await completeCheckout(fake, user, (await subscribe(user, { option: "month", email: "three@example.net", offer: "launch-week" })).url, { email: "three@example.net" });
		assert.equal((await api(user, "GET", `/offers/${offer.id}`)).body.status, "used_up", "at its limit");
	});

	test("a repeat of the checkout event counts nobody twice", async () => {
		const user = await offerSeller();
		await makeOffer(user);
		const { event } = await completeCheckout(fake, user, (await subscribe(user, { option: "month", email: "once@example.net", offer: "launch-week" })).url, { email: "once@example.net" });
		await postPaymentEvent(event);
		assert.equal((await api(user, "GET", `/offers/launch-week`)).body.redemptions, 1);
	});
});

describe("changing and deleting offers", () => {
	test("rename, switch off and back on, and the tiers it applies to", async () => {
		const user = await offerSeller();
		const supporter = await addTier(user, { name: "Supporter", yearlyCents: 12000 });
		const offer = await makeOffer(user);
		const renamed = await api(user, "PATCH", `/offers/${offer.code}`, { name: "Spring sale", tiers: ["Supporter"] });
		assert.deepEqual([renamed.body.name, renamed.body.tiers, renamed.body.code], ["Spring sale", [supporter.id], "launch-week"]);
		const all = await api(user, "PATCH", `/offers/${offer.id}`, { tiers: [] });
		assert.deepEqual(all.body.tiers, []);
		assert.deepEqual([(await api(user, "PATCH", `/offers/${offer.id}`, { active: false })).body.status, (await api(user, "PATCH", `/offers/${offer.id}`, { active: true })).body.status], ["inactive", "live"]);
		assert.equal(fake.coupons.size, 1, "its terms are the coupon's: nothing new was made");
	});

	test("deleting removes the coupon and the link, and clears a banner that pointed at it", async () => {
		const user = await offerSeller();
		const offer = await makeOffer(user);
		await api(user, "PATCH", `/newsletters/${user.slug}/launch-banner`, { enabled: true, text: "Launch week", offer: offer.id });
		const removed = await api(user, "DELETE", `/offers/${offer.id}`);
		assert.deepEqual(removed.body, { id: offer.id, deleted: true });
		assert.equal(fake.coupons.size, 0);
		assertError(await api(user, "GET", `/offers/${offer.id}`), 404, "not_found");
		const { banner } = (await api(user, "GET", `/newsletters/${user.slug}/offers`)).body;
		assert.deepEqual([banner.enabled, banner.offerId], [false, null]);
		assert.equal(await render(m.offerPage, user, { code: "launch-week" }).catch((error) => error.message), "NEXT_NOT_FOUND");
	});
});

describe("the launch offer banner", () => {
	const text = (markup) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

	test("shows a line above the website, linking to the offer, while the paid tier is open", async () => {
		const user = await offerSeller();
		const offer = await makeOffer(user);
		assert.deepEqual((await api(user, "PATCH", `/newsletters/${user.slug}/launch-banner`, { enabled: true, text: "Launch week: 25% off", offer: offer.code })).body, { enabled: true, text: "Launch week: 25% off", offerId: offer.id });
		const markup = renderToStaticMarkup(await anonymous(() => m.layout({ children: null, params: Promise.resolve({ slug: user.slug }) })));
		assert.match(text(markup), /Launch week: 25% off/);
		assert.match(markup, new RegExp(`href="https://${user.slug}\\.flockstackmail\\.com/offer/launch-week"`));

		await api(user, "PATCH", `/newsletters/${user.slug}/launch-banner`, { offer: null });
		assert.match(renderToStaticMarkup(await anonymous(() => m.layout({ children: null, params: Promise.resolve({ slug: user.slug }) }))), new RegExp(`href="https://${user.slug}\\.flockstackmail\\.com/subscribe"[^>]*>Launch week`));
	});

	test("hides itself when the offer ends, the paid tier closes or it is switched off", async () => {
		const user = await offerSeller();
		const offer = await makeOffer(user);
		await api(user, "PATCH", `/newsletters/${user.slug}/launch-banner`, { enabled: true, text: "Launch week: 25% off", offer: offer.id });
		const show = async () => text(renderToStaticMarkup(await anonymous(() => m.layout({ children: null, params: Promise.resolve({ slug: user.slug }) }))));
		assert.match(await show(), /Launch week/);
		await api(user, "PATCH", `/offers/${offer.id}`, { active: false });
		assert.doesNotMatch(await show(), /Launch week/, "its offer ended");
		await api(user, "PATCH", `/offers/${offer.id}`, { active: true });
		assert.match(await show(), /Launch week/);
		await api(user, "PATCH", `/newsletters/${user.slug}/paid-tier`, { enabled: false });
		assert.doesNotMatch(await show(), /Launch week/, "no paid tier to join");
		await api(user, "PATCH", `/newsletters/${user.slug}/paid-tier`, { enabled: true });
		await api(user, "PATCH", `/newsletters/${user.slug}/launch-banner`, { enabled: false });
		assert.doesNotMatch(await show(), /Launch week/);
	});

	test("needs text to be shown, and a real offer to link to", async () => {
		const user = await offerSeller();
		assert.match(assertError(await api(user, "PATCH", `/newsletters/${user.slug}/launch-banner`, { enabled: true }), 400, "validation_failed"), /text/);
		assertError(await api(user, "PATCH", `/newsletters/${user.slug}/launch-banner`, { text: "x", offer: "nothing" }), 404, "not_found");
	});
});
