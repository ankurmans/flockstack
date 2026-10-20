import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { anonymous, jsonRequest, startTestApp } from "./helpers/app.mjs";
import { DAY, addReader, addTier, completeCheckout, sendIssue, setTier, skipJobs } from "./helpers/paid.mjs";
import { WEBHOOK_SECRET, api, assertError, createSeller, installFakeStripe, postPaymentEvent } from "./helpers/shop.mjs";
import { runWithRequest } from "./stubs/next-headers.mjs";
import { published } from "./stubs/qstash.mjs";
import { sent as emails } from "./stubs/ses.mjs";

// Gift subscriptions: a one-time Checkout that gives a recipient months of a paid tier on a chosen day, with the buyer's
// message and a link to redeem; gifts the buyer can see, and the rule for when an unredeemed one expires.
let app;
let m;
let fake;
let counter = 0;
let visitors = 0;
let consumed = 0;

const seller = (options = {}) => createSeller(`gifts${++counter}@example.com`, { fake, ...options });
const today = () => new Date().toISOString().slice(0, 10);
const inDays = (days) => new Date(Date.now() + days * DAY * 1000).toISOString().slice(0, 10);

async function giftSeller() {
	const user = await seller();
	await setTier(user);
	const on = await api(user, "PATCH", `/newsletters/${user.slug}/gifts`, { enabled: true });
	assert.equal(on.status, 200, JSON.stringify(on.body));
	return user;
}

async function buy(user, fields = {}, { ip = `192.0.2.${(++visitors % 250) + 1}` } = {}) {
	const actions = await import("../app/archive/shop-actions.js");
	const data = new FormData();
	for (const [key, value] of Object.entries({ newsletter: user.slug, months: 12, recipientEmail: "friend@example.net", buyerEmail: "buyer@example.net", buyerName: "Sam", message: "Happy birthday!", deliverOn: today(), ...fields })) data.set(key, String(value));
	return runWithRequest({ headers: { "x-forwarded-for": ip } }, () => actions.buyGift(null, data));
}

// The buyer pays at Stripe and the webhook hears of it.
async function paidGift(user, fields = {}) {
	const answer = await buy(user, fields);
	assert.ok(answer.url, JSON.stringify(answer));
	const { result } = await completeCheckout(fake, user, answer.url, { email: fields.buyerEmail ?? "buyer@example.net" });
	assert.equal(result.status, 200, JSON.stringify(result.body));
	return m.Gift.findOne({ accountId: user.accountId, stripeSessionId: [...fake.sessions.values()].at(-1).id }).lean();
}

const deliveries = () => published.slice(consumed).filter(({ url }) => url.endsWith("/api/jobs/deliver-gift"));

async function runDelivery(job) {
	consumed = published.indexOf(job) + 1;
	const response = await m.deliverRoute.POST(jsonRequest(job.url, { method: "POST", body: job.body }));
	return { status: response.status, ...(await response.json()) };
}

const redeemUrlIn = (email) => /https?:\/\/[^\s"<>]+\/gift\?token=[A-Za-z0-9_.-]+/.exec(email.text)?.[0];
const tokenOf = (url) => new URL(url).searchParams.get("token");

async function render(page, props) {
	return renderToStaticMarkup(await anonymous(() => page(props)));
}

before(async () => {
	app = await startTestApp({ STRIPE_PAYMENTS_WEBHOOK_SECRET: WEBHOOK_SECRET, QSTASH_CURRENT_SIGNING_KEY: "sig-current", QSTASH_NEXT_SIGNING_KEY: "sig-next" });
	m = {
		deliverRoute: await import("../app/api/jobs/deliver-gift/route.js"),
		sendBatchRoute: await import("../app/api/jobs/send-batch/route.js"),
		givePage: (await import("../app/archive/[slug]/give/page.js")).default,
		subscribePage: (await import("../app/archive/[slug]/subscribe/page.js")).default,
		giftPage: (await import("../app/gift/page.js")).default,
		giftActions: await import("../app/gift/actions.js"),
		giftsPage: (await import("../app/gifts/page.js")).default,
		ProviderSubscribe: (await import("../components/ProviderSubscribe.jsx")).default,
		gifts: await import("../lib/gifts.js"),
		rules: await import("../lib/gift-rules.js"),
		links: await import("../lib/paid-links.js"),
		Contact: (await import("../models/Contact.js")).default,
		Gift: (await import("../models/Gift.js")).default,
		Suppression: (await import("../models/Suppression.js")).default,
	};
	skipJobs();
});

after(() => app?.stop());

beforeEach(() => {
	fake = installFakeStripe();
	skipJobs();
	consumed = published.length;
});

describe("the rules", () => {
	test("a gift's price is the tier's: a year is the yearly price, the rest are months of the monthly price", () => {
		const tier = { prices: { month: 800, quarter: 2000, year: 7000, lifetime: 0 } };
		assert.deepEqual(m.rules.getGiftOptions(tier), [{ months: 1, cents: 800 }, { months: 3, cents: 2000 }, { months: 6, cents: 4800 }, { months: 12, cents: 7000 }]);
		assert.deepEqual(m.rules.getGiftOptions({ prices: { month: 0, quarter: 0, year: 9000 } }), [{ months: 12, cents: 9000 }], "a yearly tier can only be given for a year");
		assert.deepEqual(m.rules.getGiftOptions({ prices: { month: 500, quarter: 0, year: 0, lifetime: 9000 } }).map(({ months }) => months), [1, 3, 6, 12]);
		assert.deepEqual(m.rules.getGiftOptions({ prices: { lifetime: 9000 } }), [], "a lifetime tier isn't given");
	});

	test("a gift expires 12 months after it was bought, and the days of delivery are read as UTC days", () => {
		const bought = new Date("2026-10-20T10:00:00Z");
		assert.equal(m.rules.getGiftExpiry(bought).toISOString(), "2027-10-20T10:00:00.000Z");
		assert.equal(m.rules.addMonths(new Date("2026-10-31T00:00:00Z"), 4).getUTCMonth() >= 0, true);
		assert.equal(m.rules.readDeliveryDay("2026-12-25").toISOString(), "2026-12-25T00:00:00.000Z");
		assert.equal(m.rules.readDeliveryDay("2026-02-30"), null);
		assert.equal(m.rules.readDeliveryDay("soon"), null);
		assert.equal(m.rules.getGiftState({ status: "sent", expiresAt: "2026-01-01T00:00:00Z" }, Date.parse("2026-02-01")), "expired");
		assert.equal(m.rules.getGiftState({ status: "redeemed", expiresAt: "2026-01-01T00:00:00Z" }, Date.parse("2026-02-01")), "redeemed");
	});

	test("the buyer's words come out as plain text", () => {
		assert.equal(m.gifts.cleanMessage("Enjoy! [click](http://evil.example) <b>now</b> https://evil.example/x www.evil.example"), "Enjoy! click now");
		assert.equal(m.gifts.cleanMessage("a\n\n\n\nb"), "a\n\nb");
		assert.equal(m.gifts.cleanMessage("x".repeat(900)).length, 500);
	});
});

describe("turning gifts on", () => {
	test("needs a Stripe account that takes payments, and the gift page needs the paid tier open too", async () => {
		const unready = await seller({ ready: false });
		await setTier(unready, { enabled: false });
		assertError(await api(unready, "PATCH", `/newsletters/${unready.slug}/gifts`, { enabled: true }), 409, "payments_not_ready");

		const user = await seller();
		await setTier(user, { enabled: false });
		const on = await api(user, "PATCH", `/newsletters/${user.slug}/gifts`, { enabled: true });
		assert.deepEqual([on.body.enabled, on.body.open], [true, false], "the paid tier is off");
		assert.match(on.body.giveUrl, /\/give$/);
		assert.equal(await render(m.givePage, { params: Promise.resolve({ slug: user.slug }) }).catch((error) => error.message), "NEXT_NOT_FOUND");
		await setTier(user);
		const page = await render(m.givePage, { params: Promise.resolve({ slug: user.slug }) });
		assert.match(page, /Give a gift subscription/);
		assert.match(page, /\$8\.00/);
		assert.match(page, /\$80\.00/);
		assert.match(page, /expires|12 months after you buy it/);
		assert.match(page, /name="deliverOn"/);
		assert.match(await render(m.subscribePage, { params: Promise.resolve({ slug: user.slug }) }), /Give a gift subscription/);
		await api(user, "PATCH", `/newsletters/${user.slug}/gifts`, { enabled: false });
		assert.doesNotMatch(await render(m.subscribePage, { params: Promise.resolve({ slug: user.slug }) }), /Give a gift subscription/);
	});

	test("the gift page's address is routed on the newsletter's host", async () => {
		const user = await giftSeller();
		const { proxy } = await import("../proxy.js");
		const { NextRequest } = await import("next/server");
		const host = `${user.slug}.flockstackmail.com`;
		const rewrite = (await proxy(new NextRequest(new URL(`https://${host}/give`), { headers: { host } }))).headers.get("x-middleware-rewrite");
		assert.match(rewrite, new RegExp(`/archive/${user.slug}/give$`));
		for (const path of ["/gift", "/gifts", "/pledge"]) {
			const response = await proxy(new NextRequest(new URL(`https://${host}${path}`), { headers: { host } }));
			assert.equal(response.headers.get("x-middleware-rewrite"), null, `${path} is an app page, not rewritten`);
			assert.equal(response.status, 200, path);
		}
	});
});

describe("buying a gift", () => {
	test("opens a one-time Checkout on the creator's account for the tier's price, without the message in Stripe", async () => {
		const user = await giftSeller();
		const answer = await buy(user, { months: 3, message: "Read this [now](http://evil.example)" });
		assert.ok(answer.url);
		const session = [...fake.sessions.values()].at(-1);
		assert.equal(session.mode, "payment");
		assert.equal(session.connectedAccount, user.stripeAccountId);
		assert.equal(session.line_items[0].price_data.unit_amount, "2400", "3 months of $8");
		assert.equal(session.line_items[0].price_data.currency, "usd");
		assert.match(session.line_items[0].price_data.product_data.name, /Gift: 3 months of .*, Paid subscription/);
		assert.equal(session.customer_email, "buyer@example.net");
		assert.deepEqual(session.metadata.kind, "gift");
		assert.doesNotMatch(JSON.stringify(session.metadata), /Read this|friend@example/, "no message or recipient in Stripe's metadata");
		assert.equal(session.success_url, `https://${user.slug}.flockstackmail.com/subscribe?gift=1`);
		assert.equal(session.cancel_url, `https://${user.slug}.flockstackmail.com/give`);
		assert.match(session.custom_text.submit.message, /12 months/);
		assert.doesNotMatch(JSON.stringify(fake.requests), /application_fee/i);

		const gift = await m.Gift.findOne({ accountId: user.accountId }).lean();
		assert.deepEqual([gift.status, gift.months, gift.amountCents, gift.recipientEmail, gift.buyerEmail, gift.buyerName], ["awaiting_payment", 3, 2400, "friend@example.net", "buyer@example.net", "Sam"]);
		assert.equal(gift.message, "Read this now", "links and markup are dropped");
	});

	test("takes the price from the tier, never the form, and only the lengths the tier can be given for", async () => {
		const user = await giftSeller();
		const yearly = await addTier(user, { name: "Year only", yearlyCents: 9000 });
		await buy(user, { months: 12, amount: "1", unit_amount: "1" });
		assert.equal([...fake.sessions.values()].at(-1).line_items[0].price_data.unit_amount, "8000");
		assert.deepEqual(await buy(user, { tier: yearly.id, months: 3 }), { error: "This newsletter doesn't offer that gift" });
		assert.ok((await buy(user, { tier: yearly.id, months: 12 })).url);
		assert.deepEqual(await buy(user, { months: 7 }), { error: "This newsletter doesn't offer that gift" });
		assert.deepEqual(await buy(user, { tier: "t_nothing" }), { error: "This newsletter doesn't offer that gift" });
	});

	test("checks the emails, the day, the honeypot and the newsletter", async () => {
		const user = await giftSeller();
		assert.match((await buy(user, { recipientEmail: "nope" })).error, /valid email for the person/);
		assert.match((await buy(user, { buyerEmail: "nope" })).error, /your own email/);
		assert.deepEqual(await buy(user, { deliverOn: inDays(-2) }), { error: "Pick today or a day to come" });
		assert.match((await buy(user, { deliverOn: inDays(400) })).error, /within 365 days/);
		assert.ok((await buy(user, { deliverOn: inDays(365) })).url, "a year ahead is the last day");
		assert.deepEqual(await buy(user, { website: "bot" }), { error: "This newsletter doesn't sell gifts" });
		assert.deepEqual(await buy(user, { newsletter: "no-such" }), { error: "This newsletter doesn't sell gifts" });
		await api(user, "PATCH", `/newsletters/${user.slug}/gifts`, { enabled: false });
		assert.deepEqual(await buy(user), { error: "This newsletter doesn't sell gifts" });
	});

	test("is limited for one network", async () => {
		const user = await giftSeller();
		const results = [];
		for (let count = 0; count < 11; count++) results.push(await buy(user, { recipientEmail: `r${count}@example.net` }, { ip: "198.51.100.88" }));
		assert.equal(results.filter(({ url }) => url).length, 10);
		assert.match(results.at(-1).error, /Too many attempts/);
	});

	test("a full founding tier can't be given", async () => {
		const user = await giftSeller();
		const founding = await addTier(user, { name: "Founding", yearlyCents: 25000, founding: { enabled: true, cap: 1 } });
		await addReader(m, user, "member@example.net", { tier: "paid", paidTierId: founding.id, paidUntil: new Date(Date.now() + 20 * DAY * 1000) });
		assert.deepEqual(await buy(user, { tier: founding.id }), { error: "All 1 founding spots are taken" });
	});
});

describe("paying for a gift", () => {
	test("the webhook marks it paid, gives it its expiry and sends the buyer a receipt that links to their gifts", async () => {
		const user = await giftSeller();
		const before = emails.length;
		const gift = await paidGift(user, { deliverOn: inDays(30) });
		assert.equal(gift.status, "paid");
		assert.ok(gift.paymentIntentId);
		assert.equal(gift.expiresAt.getTime(), m.rules.getGiftExpiry(gift.paidAt).getTime());
		assert.ok(Math.abs(gift.expiresAt.getTime() - Date.now() - 365 * DAY * 1000) < 2 * DAY * 1000);

		const receipt = emails.slice(before).find(({ to }) => to === "buyer@example.net");
		assert.match(receipt.subject, /Your gift for friend@example\.net is paid/);
		assert.match(receipt.text, /12 months/);
		assert.match(receipt.text, /can be redeemed until/);
		assert.match(receipt.text, /\/gifts\?token=/);
		assert.equal(emails.slice(before).some(({ to }) => to === "friend@example.net"), false, "nothing to the recipient before the day");
		assert.doesNotMatch(receipt.html, /Unsubscribe/i);
	});

	test("a repeated event sends one receipt and schedules one delivery", async () => {
		const user = await giftSeller();
		const before = emails.length;
		const answer = await buy(user, { deliverOn: inDays(3) });
		const { event } = await completeCheckout(fake, user, answer.url, { email: "buyer@example.net" });
		await postPaymentEvent(event);
		assert.equal(emails.slice(before).filter(({ to }) => to === "buyer@example.net").length, 1);
		assert.equal(deliveries().length, 1);
	});

	test("an unpaid session makes no gift", async () => {
		const user = await giftSeller();
		const answer = await buy(user);
		const session = [...fake.sessions.values()].find((candidate) => candidate.url === answer.url);
		const result = await postPaymentEvent(fake.event("checkout.session.completed", { ...session, payment_status: "unpaid" }, { account: user.stripeAccountId }));
		assert.equal(result.body.ignored, "not paid yet");
		assert.equal((await m.Gift.findOne({ accountId: user.accountId }).lean()).status, "awaiting_payment");
	});
});

describe("delivery on the chosen day", () => {
	test("a gift for today is emailed with the buyer's message, a link and the expiry rule, and only once", async () => {
		const user = await giftSeller();
		const before = emails.length;
		await paidGift(user, { deliverOn: today(), message: "Happy birthday!\nSee you soon." });
		const [job] = deliveries();
		assert.equal(job.notBefore, undefined, "due now");
		assert.deepEqual((await runDelivery(job)).sent, true);

		const email = emails.slice(before).find(({ to }) => to === "friend@example.net");
		assert.match(email.subject, /Sam gave you 12 months of/);
		assert.match(email.text, /Happy birthday!/);
		assert.match(email.text, /See you soon\./);
		assert.match(email.text, /Redeem your gift/);
		assert.match(email.text, /months? start the day you redeem it|start the day you redeem it/);
		assert.match(email.text, /expires after that/);
		assert.match(email.text, /bought you a gift subscription/);
		assert.doesNotMatch(email.html, /Unsubscribe/i, "a one-time email, not a subscription");
		assert.ok(redeemUrlIn(email));

		const again = await runDelivery(job);
		assert.equal(again.skipped, "sent");
		assert.equal(emails.slice(before).filter(({ to }) => to === "friend@example.net").length, 1);
		assert.equal((await m.Gift.findOne({ accountId: user.accountId }).lean()).status, "sent");
	});

	test("a gift for a later day waits for it, republishing itself for long waits", async () => {
		const user = await giftSeller();
		const before = emails.length;
		const gift = await paidGift(user, { deliverOn: inDays(30) });
		const [job] = deliveries();
		assert.ok(job.notBefore * 1000 > Date.now() + 29 * DAY * 1000, "the job is for the day");
		const waiting = await runDelivery(job);
		assert.equal(waiting.waiting, true);
		const [next] = deliveries();
		const delay = next.notBefore * 1000 - Date.now();
		assert.ok(delay > 5 * DAY * 1000 && delay <= 6 * DAY * 1000 + 5000, "no more than 6 days at a time");
		assert.equal(emails.slice(before).some(({ to }) => to === "friend@example.net"), false);

		await m.Gift.updateOne({ accountId: user.accountId, _id: gift._id }, { $set: { deliverOn: new Date(Date.now() - 1000) } });
		assert.equal((await runDelivery(next)).sent, true);
		assert.equal(emails.slice(before).some(({ to }) => to === "friend@example.net"), true);
	});

	test("the hourly check delivers a gift whose job was lost, and expires one nobody redeemed", async () => {
		const user = await giftSeller();
		const gift = await paidGift(user, { deliverOn: inDays(5) });
		await m.Gift.updateOne({ accountId: user.accountId, _id: gift._id }, { $set: { deliverOn: new Date(Date.now() - 1000) } });
		const before = emails.length;
		assert.equal((await m.gifts.deliverDueGifts()).sent, 1);
		assert.equal(emails.slice(before).filter(({ to }) => to === "friend@example.net").length, 1);
		assert.equal((await m.gifts.deliverDueGifts()).sent, 0, "once");

		await m.Gift.updateOne({ accountId: user.accountId, _id: gift._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
		assert.equal((await m.gifts.expireGifts()).expired >= 1, true);
		assert.equal((await m.Gift.findOne({ accountId: user.accountId, _id: gift._id }).lean()).status, "expired");
	});

	test("a recipient the email can't reach is reported, and the writer resends to another address", async () => {
		const user = await giftSeller();
		await m.Suppression.create({ accountId: user.accountId, email: "friend@example.net", reason: "bounce" });
		const gift = await paidGift(user);
		const [job] = deliveries();
		const result = await runDelivery(job);
		assert.equal(result.sent, false);
		const stored = await m.Gift.findOne({ accountId: user.accountId, _id: gift._id }).lean();
		assert.deepEqual([stored.status, stored.deliveryError], ["paid", "suppressed"]);
		const listed = await api(user, "GET", `/newsletters/${user.slug}/gifts`);
		assert.equal(listed.body.gifts[0].deliveryError, "suppressed");

		const before = emails.length;
		const resent = await api(user, "POST", `/gifts/${gift._id}/resend`, { recipientEmail: "other@example.net" });
		assert.equal(resent.status, 200, JSON.stringify(resent.body));
		assert.deepEqual([resent.body.status, resent.body.recipientEmail, resent.body.deliveryError], ["sent", "other@example.net", null]);
		assert.equal(emails.slice(before).some(({ to }) => to === "other@example.net"), true);
		assertError(await api(user, "POST", `/gifts/${gift._id}/resend`, { recipientEmail: "nope" }), 422, "send_check_failed");
	});
});

describe("redeeming", () => {
	async function sentGift(user, fields = {}) {
		const before = emails.length;
		const gift = await paidGift(user, fields);
		const [job] = deliveries();
		await runDelivery(job);
		const email = emails.slice(before).find(({ to }) => to === (fields.recipientEmail ?? "friend@example.net"));
		return { gift, url: redeemUrlIn(email), token: tokenOf(redeemUrlIn(email)) };
	}

	test("the page shows the gift, and the button gives paid access for its months from that day", async () => {
		const user = await giftSeller();
		const { gift, token } = await sentGift(user, { months: 6, message: "For you" });
		const page = await render(m.giftPage, { searchParams: Promise.resolve({ token }) });
		assert.match(page, /Sam gave you 6 months of/);
		assert.match(page, /For you/);
		assert.match(page, /Redeem my gift/);
		assert.match(page, /start when you redeem it/);
		assert.equal((await m.Gift.findOne({ accountId: user.accountId, _id: gift._id }).lean()).status, "sent", "opening the page redeems nothing");

		const done = await anonymous(() => m.giftActions.redeem(token));
		assert.equal(done.ok, true);
		const until = new Date(done.until);
		assert.ok(Math.abs(until.getTime() - m.rules.addMonths(new Date(), 6).getTime()) < 60_000);

		const contact = await m.Contact.findOne({ accountId: user.accountId, email: "friend@example.net" }).lean();
		assert.deepEqual([contact.status, contact.source, contact.tier, contact.paidTierId, contact.grant.kind, contact.grant.giftId], ["active", "gift", "paid", "paid", "gift", String(gift._id)]);
		assert.equal(contact.grant.until.getTime(), until.getTime());
		const stored = await m.Gift.findOne({ accountId: user.accountId, _id: gift._id }).lean();
		assert.deepEqual([stored.status, String(stored.contactId)], ["redeemed", String(contact._id)]);
		const tier = (await api(user, "GET", `/newsletters/${user.slug}/tiers`)).body.tiers[0];
		assert.deepEqual([tier.readers.paid, tier.readers.gift, tier.readers.comp], [1, 1, 0], "shown as a gift, not as paying");

		skipJobs();
		const issue = await sendIssue(m, user, { audience: "paid", subject: "For paid readers" });
		assert.deepEqual(issue.emails.map(({ to }) => to), ["friend@example.net"], "paid issues reach them");
	});

	test("a second click changes nothing, and a gift to an existing free subscriber upgrades that contact", async () => {
		const user = await giftSeller();
		await addReader(m, user, "friend@example.net", { subscribedAt: new Date(Date.now() - 10 * DAY * 1000) });
		const { token } = await sentGift(user);
		const first = await anonymous(() => m.giftActions.redeem(token));
		const second = await anonymous(() => m.giftActions.redeem(token));
		assert.deepEqual([first.ok, second.ok, second.already, second.until], [true, true, true, first.until]);
		assert.equal(await m.Contact.countDocuments({ accountId: user.accountId, email: "friend@example.net" }), 1);
	});

	test("starts after the paid time a recipient already has, so none of it is wasted", async () => {
		const user = await giftSeller();
		const end = new Date(Date.now() + 40 * DAY * 1000);
		await addReader(m, user, "friend@example.net", { tier: "paid", paidUntil: end, subscriptionStatus: "active", stripeSubscriptionId: "sub_existing", stripeCustomerId: "cus_existing" });
		const { token } = await sentGift(user, { months: 1 });
		const done = await anonymous(() => m.giftActions.redeem(token));
		assert.ok(Math.abs(new Date(done.until).getTime() - m.rules.addMonths(end, 1).getTime()) < 1000);
		const contact = await m.Contact.findOne({ accountId: user.accountId, email: "friend@example.net" }).lean();
		assert.equal(contact.paidUntil.getTime(), end.getTime(), "their subscription still pays");
		assert.equal(contact.grant.kind, "gift");
	});

	test("an unredeemed gift expires 12 months after it was bought, and the link says so", async () => {
		const user = await giftSeller();
		const { gift, token } = await sentGift(user);
		await m.Gift.updateOne({ accountId: user.accountId, _id: gift._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
		const page = await render(m.giftPage, { searchParams: Promise.resolve({ token }) });
		assert.match(page, /This gift has expired/);
		assert.equal((await anonymous(() => m.giftActions.redeem(token))).error, "expired");
		assert.equal(await m.Contact.countDocuments({ accountId: user.accountId, email: "friend@example.net" }), 0, "nobody was subscribed");
	});

	test("refuses forged, mixed-up and unpaid links", async () => {
		const user = await giftSeller();
		const { gift, token } = await sentGift(user);
		assert.equal((await anonymous(() => m.giftActions.redeem(`${token.slice(0, -2)}xx`))).error, "invalid");
		assert.equal((await anonymous(() => m.giftActions.redeem("garbage"))).error, "invalid");
		const wrongKind = m.links.createPaidToken("pledge-cancel", { g: String(gift._id), n: String(user.newsletterId) });
		assert.equal((await anonymous(() => m.giftActions.redeem(wrongKind))).error, "invalid");
		const unpaid = await buy(user, { recipientEmail: "other@example.net" });
		assert.ok(unpaid.url);
		const awaiting = await m.Gift.findOne({ accountId: user.accountId, recipientEmail: "other@example.net" }).lean();
		const early = m.links.createPaidToken("gift-redeem", { g: String(awaiting._id), n: String(user.newsletterId) });
		assert.equal((await anonymous(() => m.giftActions.redeem(early))).error, "invalid", "a gift that wasn't paid can't be redeemed");
		assert.match(await render(m.giftPage, { searchParams: Promise.resolve({ token: "nope" }) }), /link doesn(?:'|&#x27;)t work/);
	});

	test("a refund in Stripe stops an unredeemed gift and takes back a redeemed one's access", async () => {
		const user = await giftSeller();
		const first = await sentGift(user);
		const refund = (gift) => postPaymentEvent(fake.event("charge.refunded", { id: "ch_1", object: "charge", payment_intent: gift.paymentIntentId, amount: gift.amountCents, amount_refunded: gift.amountCents, refunded: true }, { account: user.stripeAccountId }));
		assert.equal((await refund(first.gift)).body.refunded, true);
		assert.equal((await anonymous(() => m.giftActions.redeem(first.token))).error, "refunded");

		const second = await sentGift(user, { recipientEmail: "second@example.net" });
		await anonymous(() => m.giftActions.redeem(second.token));
		assert.equal((await m.Contact.findOne({ accountId: user.accountId, email: "second@example.net" }).lean()).tier, "paid");
		await refund(second.gift);
		const contact = await m.Contact.findOne({ accountId: user.accountId, email: "second@example.net" }).lean();
		assert.equal(contact.tier, "free");
		assert.equal(contact.grant, undefined);
		const partial = await postPaymentEvent(fake.event("charge.refunded", { id: "ch_2", object: "charge", payment_intent: second.gift.paymentIntentId, amount: 8000, amount_refunded: 100 }, { account: user.stripeAccountId }));
		assert.ok(partial.body.ignored);
	});
});

describe("the buyer's page", () => {
	test("lists their gifts with whether each was redeemed, and a link to forward the unredeemed ones", async () => {
		const user = await giftSeller();
		const before = emails.length;
		await paidGift(user, { recipientEmail: "waiting@example.net", deliverOn: inDays(10) });
		const sentOne = await paidGift(user, { recipientEmail: "redeemed@example.net" });
		await paidGift(user, { recipientEmail: "other-buyer@example.net", buyerEmail: "someone-else@example.net" });
		await m.gifts.deliverDueGifts();
		const mail = emails.slice(before).find(({ to, subject }) => to === "buyer@example.net" && /is paid/.test(subject));
		const url = /https?:\/\/[^\s"<>]+\/gifts\?token=[A-Za-z0-9_.-]+/.exec(mail.text)[0];
		const gift = await m.Gift.findOne({ accountId: user.accountId, _id: sentOne._id }).lean();
		const redeemLink = m.gifts.getGiftRedeemUrl(gift, { _id: user.newsletterId, slug: user.slug, archiveHost: undefined });
		await anonymous(() => m.giftActions.redeem(tokenOf(redeemLink)));

		const page = (await render(m.giftsPage, { searchParams: Promise.resolve({ token: tokenOf(url) }) })).replaceAll("<!-- -->", "");
		assert.match(page, /Your gifts to/);
		assert.match(page, /for waiting@example\.net/);
		assert.match(page, /Waiting for its delivery day/);
		assert.match(page, /for redeemed@example\.net/);
		assert.match(page, /Redeemed on/);
		assert.doesNotMatch(page, /other-buyer@example\.net/, "only their own");
		assert.match(page, /\/gift\?token=/, "a link for the unredeemed one");
		assert.match(page, /Expires/);
		assert.match(await render(m.giftsPage, { searchParams: Promise.resolve({ token: "nope" }) }), /link doesn(?:'|&#x27;)t work/);
		assert.equal(m.links.readPaidToken("gift-buyer", tokenOf(redeemLink)), null, "a gift link is not a buyer link");
	});
});

describe("the writer's list", () => {
	test("shows every gift paid for, with its state, filters and pages", async () => {
		const user = await giftSeller();
		const stranger = await seller();
		await paidGift(user, { recipientEmail: "a@example.net" });
		await paidGift(user, { recipientEmail: "b@example.net", deliverOn: inDays(9) });
		await buy(user, { recipientEmail: "unpaid@example.net" });
		const all = await api(user, "GET", `/newsletters/${user.slug}/gifts`);
		assert.deepEqual(all.body.gifts.map(({ recipientEmail }) => recipientEmail).sort(), ["a@example.net", "b@example.net"], "unpaid ones aren't gifts yet");
		assert.deepEqual(all.body.settings, { newsletterId: user.newsletterId, enabled: true, open: true, giveUrl: `https://${user.slug}.flockstackmail.com/give` });
		const gift = all.body.gifts[0];
		assert.deepEqual([gift.tierName, gift.months, gift.amountCents, gift.message, gift.buyerName], ["Paid subscription", 12, 8000, "Happy birthday!", "Sam"]);
		assert.equal((await api(user, "GET", `/newsletters/${user.slug}/gifts?status=redeemed`)).body.gifts.length, 0);
		const page = await api(user, "GET", `/newsletters/${user.slug}/gifts?limit=1`);
		assert.equal(page.body.gifts.length, 1);
		assert.ok(page.body.nextCursor);
		assertError(await api(stranger, "GET", `/newsletters/${user.slug}/gifts`), 404, "not_found");
		assertError(await api(stranger, "POST", `/gifts/${gift.id}/resend`, {}), 404, "not_found");
	});
});
