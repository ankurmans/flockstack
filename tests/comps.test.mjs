import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { startTestApp } from "./helpers/app.mjs";
import { DAY, addReader, addTier, completeCheckout, readerOf, sendIssue, setTier, skipJobs, subscribe } from "./helpers/paid.mjs";
import { WEBHOOK_SECRET, api, assertError, createSeller, installFakeStripe, postPaymentEvent } from "./helpers/shop.mjs";
import { flushAfter } from "./stubs/next-server.mjs";
import { published } from "./stubs/qstash.mjs";

// Comp access: the writer gives a contact paid access by hand until a day. It shows apart from paying readers, is never counted as
// revenue, works beside a Stripe subscription and ends on its day.
let app;
let m;
let fake;
let counter = 0;

const seller = (options = {}) => createSeller(`comps${++counter}@example.com`, { fake, ...options });
const inDays = (days) => new Date(Date.now() + days * DAY * 1000).toISOString();

async function compSeller() {
	const user = await seller();
	await setTier(user);
	await addReader(m, user, "press@example.net");
	return user;
}

const comp = (user, body) => api(user, "POST", `/newsletters/${user.slug}/comps`, { contact: "press@example.net", endsAt: inDays(30), ...body });

before(async () => {
	app = await startTestApp({ STRIPE_PAYMENTS_WEBHOOK_SECRET: WEBHOOK_SECRET, QSTASH_CURRENT_SIGNING_KEY: "sig-current", QSTASH_NEXT_SIGNING_KEY: "sig-next" });
	m = {
		sendBatchRoute: await import("../app/api/jobs/send-batch/route.js"),
		webhooks: await import("../lib/webhooks.js"),
		access: await import("../lib/grant-access.js"),
		grants: await import("../lib/grants.js"),
		tiers: await import("../lib/tiers.js"),
		Contact: (await import("../models/Contact.js")).default,
	};
	skipJobs();
});

after(() => app?.stop());

beforeEach(() => {
	fake = installFakeStripe();
	skipJobs();
});

describe("giving comp access", () => {
	test("makes a contact a paid reader of a tier until the day, in the lowest tier by default", async () => {
		const user = await compSeller();
		const endsAt = inDays(30);
		const response = await comp(user, { endsAt, note: "Reviewing the book" });
		assert.equal(response.status, 201, JSON.stringify(response.body));
		assert.deepEqual(
			[response.body.email, response.body.tierId, response.body.tierName, new Date(response.body.endsAt).getTime(), response.body.note, response.body.alsoPays],
			["press@example.net", "paid", "Paid subscription", new Date(endsAt).getTime(), "Reviewing the book", false]
		);
		const contact = await readerOf(m, user, "press@example.net");
		assert.deepEqual([contact.tier, contact.paidTierId, contact.grant.kind, contact.grant.note], ["paid", "paid", "comp", "Reviewing the book"]);
		assert.ok(m.tiers.isPaidContact(contact));
		assert.equal(contact.paidUntil.getTime(), new Date(endsAt).getTime() - m.tiers.PAID_GRACE_MS, "the 3 days of grace for a missed Stripe event don't lengthen a comp");
		assert.equal(contact.stripeSubscriptionId, undefined);
	});

	test("can be for another tier, found by name, and giving it again changes the tier and the day", async () => {
		const user = await compSeller();
		const supporter = await addTier(user, { name: "Supporter", yearlyCents: 12000 });
		const first = await comp(user, { tier: "supporter" });
		assert.equal(first.body.tierId, supporter.id);
		const second = await comp(user, { tier: "Paid subscription", endsAt: inDays(60) });
		assert.deepEqual([second.status, second.body.tierId], [201, "paid"]);
		assert.equal((await readerOf(m, user, "press@example.net")).paidTierId, "paid");
		assert.equal((await api(user, "GET", `/newsletters/${user.slug}/comps`)).body.comps.length, 1);
	});

	test("takes the contact by ID or address, and only an active one that is already on the list", async () => {
		const user = await compSeller();
		const contact = await readerOf(m, user, "press@example.net");
		assert.equal((await comp(user, { contact: String(contact._id) })).status, 201);
		assert.equal((await comp(user, { contact: "PRESS@example.net" })).status, 201, "any case");
		assertError(await comp(user, { contact: "stranger@example.net" }), 404, "not_found");
		assert.match(assertError(await comp(user, { contact: "stranger@example.net" }), 404, "not_found"), /add them to the newsletter first/);
		await addReader(m, user, "gone@example.net", { status: "unsubscribed" });
		assert.match(assertError(await comp(user, { contact: "gone@example.net" }), 409, "conflict"), /active contact/);
		await addReader(m, user, "waiting@example.net", { status: "pending" });
		assertError(await comp(user, { contact: "waiting@example.net" }), 409, "conflict");
	});

	test("needs a day to come, within 5 years, and a tier the newsletter has", async () => {
		const user = await compSeller();
		assert.match(assertError(await comp(user, { endsAt: "2020-01-01T00:00:00Z" }), 400, "validation_failed"), /future/);
		assert.match(assertError(await comp(user, { endsAt: "soon" }), 400, "validation_failed"), /future/);
		assert.match(assertError(await comp(user, { endsAt: inDays(366 * 6) }), 400, "validation_failed"), /5 years/);
		assert.match(assertError(await comp(user, { tier: "Nobody" }), 400, "validation_failed"), /no paid tier/);
		const bare = await seller();
		await addReader(m, bare, "press@example.net");
		assert.match(assertError(await comp(bare, {}), 409, "conflict"), /paid tier first/);
	});

	test("belongs to the newsletter's account only", async () => {
		const user = await compSeller();
		const stranger = await seller();
		assertError(await api(stranger, "POST", `/newsletters/${user.slug}/comps`, { contact: "press@example.net", endsAt: inDays(3) }), 404, "not_found");
		assertError(await api(stranger, "GET", `/newsletters/${user.slug}/comps`), 404, "not_found");
		assertError(await api(stranger, "DELETE", `/newsletters/${user.slug}/comps/press@example.net`), 404, "not_found");
	});
});

describe("a comp is shown apart from paying readers", () => {
	test("in the contact, the tier's readers, the comps list and the paid settings", async () => {
		const user = await compSeller();
		await addReader(m, user, "payer@example.net", { tier: "paid", paidUntil: new Date(Date.now() + 20 * DAY * 1000), subscriptionStatus: "active", stripeSubscriptionId: "sub_p", paidInterval: "month" });
		await comp(user, { endsAt: inDays(30) });

		const contacts = await api(user, "GET", "/contacts?tier=paid");
		const byEmail = Object.fromEntries(contacts.body.contacts.map((contact) => [contact.email, contact]));
		assert.deepEqual([byEmail["press@example.net"].paidAccess, byEmail["press@example.net"].paidTierId, byEmail["press@example.net"].tier], ["comp", "paid", "paid"]);
		assert.deepEqual([byEmail["payer@example.net"].paidAccess, byEmail["payer@example.net"].paidTierId], ["stripe", "paid"]);
		assert.ok(Math.abs(new Date(byEmail["press@example.net"].paidUntil).getTime() - Date.now() - 30 * DAY * 1000) < 60_000, "the day it ends, not the stored one");

		const [tier] = (await api(user, "GET", `/newsletters/${user.slug}/tiers`)).body.tiers;
		assert.deepEqual(tier.readers, { paid: 2, paying: 1, comp: 1, gift: 0 });
		const settings = (await api(user, "GET", `/newsletters/${user.slug}/paid-tier`)).body;
		assert.deepEqual([settings.paidSubscribers, settings.payingSubscribers, settings.compSubscribers, settings.giftSubscribers], [2, 1, 1, 0]);
		const list = (await api(user, "GET", `/newsletters/${user.slug}/comps`)).body.comps;
		assert.deepEqual(list.map(({ email, tierName }) => [email, tierName]), [["press@example.net", "Paid subscription"]]);
	});

	test("never in what the tiers earn", async () => {
		const user = await compSeller();
		await addReader(m, user, "monthly@example.net", { tier: "paid", paidUntil: new Date(Date.now() + 20 * DAY * 1000), subscriptionStatus: "active", paidInterval: "month" });
		await addReader(m, user, "yearly@example.net", { tier: "paid", paidUntil: new Date(Date.now() + 200 * DAY * 1000), subscriptionStatus: "active", paidInterval: "year" });
		await addReader(m, user, "life@example.net", { tier: "paid", paidUntil: new Date("2099-12-31"), paidInterval: "lifetime" });
		const before = (await api(user, "GET", `/newsletters/${user.slug}/paid-report`)).body;
		assert.deepEqual([before.paying, before.comp, before.monthlyRecurringCents], [3, 0, 800 + Math.round(8000 / 12)], "a lifetime payment isn't recurring");

		await comp(user, { endsAt: inDays(30) });
		await addReader(m, user, "second@example.net");
		await comp(user, { contact: "second@example.net", endsAt: inDays(30) });
		const after = (await api(user, "GET", `/newsletters/${user.slug}/paid-report`)).body;
		assert.deepEqual([after.paying, after.comp, after.gift, after.monthlyRecurringCents], [3, 2, 0, before.monthlyRecurringCents], "two comps change no revenue");
		assert.deepEqual([after.tiers[0].monthly, after.tiers[0].yearly, after.tiers[0].comp], [1, 1, 2]);
		assert.equal(after.currency, "usd");
	});

	test("segments see a comp reader as paid, in their tier", async () => {
		const user = await compSeller();
		await comp(user, {});
		const response = await api(user, "POST", "/segments/preview", { rules: { match: "all", conditions: [{ type: "tier", value: "paid" }] }, sample: 5 });
		assert.deepEqual(response.body.sample.map(({ email }) => email), ["press@example.net"]);
	});
});

describe("what a comp opens", () => {
	test("paid issues reach the reader, and an ended comp stops them on its day", async () => {
		const user = await compSeller();
		await comp(user, { endsAt: inDays(30) });
		const sent = await sendIssue(m, user, { audience: "paid", subject: "For paid readers" });
		assert.deepEqual(sent.emails.map(({ to }) => to), ["press@example.net"]);

		const contact = await readerOf(m, user, "press@example.net");
		await m.Contact.updateOne({ accountId: user.accountId, _id: contact._id }, { $set: { "grant.until": new Date(Date.now() - 1000), paidUntil: new Date(Date.now() - 1000 - m.tiers.PAID_GRACE_MS) } });
		skipJobs();
		const draft = await api(user, "POST", "/campaigns", { subject: "Too late", content: "Hi", audience: "paid" });
		assert.equal((await api(user, "GET", `/campaigns/${draft.body.id}`)).body.audienceSize, 0, "not on the day after");
	});

	test("the hourly check takes the access away when the day passes, and tells webhooks", async () => {
		const user = await compSeller();
		const endpoint = await api(user, "POST", "/webhooks", { url: "https://hooks.example.com/in", events: ["subscriber.upgraded", "subscriber.downgraded"] });
		assert.equal(endpoint.status, 201, JSON.stringify(endpoint.body));
		const before = published.length;
		await comp(user, { endsAt: inDays(10), note: "Partner" });
		const contact = await readerOf(m, user, "press@example.net");
		await m.Contact.updateOne({ accountId: user.accountId, _id: contact._id }, { $set: { "grant.until": new Date(Date.now() - 1000), paidUntil: new Date(Date.now() - 1000 - m.tiers.PAID_GRACE_MS) } });
		const result = await m.access.expireGrants();
		assert.ok(result.expired >= 1);
		const after = await readerOf(m, user, "press@example.net");
		assert.deepEqual([after.tier, after.grant], ["free", undefined]);
		assert.equal((await m.access.expireGrants()).expired, 0, "once");
		await flushAfter();

		const requests = [];
		for (const { url, body } of published.slice(before).filter(({ url: target }) => target.endsWith("/api/jobs/deliver-webhook"))) {
			void url;
			await m.webhooks.deliverWebhook(body, { fetchImpl: async (_url, init) => (requests.push(JSON.parse(init.body)), new Response("ok")) });
		}
		assert.deepEqual(requests.map(({ type }) => type), ["subscriber.upgraded", "subscriber.downgraded"]);
		const [upgraded, downgraded] = requests;
		assert.deepEqual([upgraded.data.source, upgraded.data.tier, upgraded.data.interval, upgraded.data.subscriber.tier, upgraded.data.subscriber.paidTierId], ["comp", { id: "paid", name: "Paid subscription" }, null, "paid", "paid"]);
		assert.deepEqual([downgraded.data.source, downgraded.data.tier, downgraded.data.subscriber.tier], ["comp", { id: "paid", name: "Paid subscription" }, "free"]);
	});
});

describe("taking a comp away", () => {
	test("makes the reader free at once, and does nothing for a reader who has none", async () => {
		const user = await compSeller();
		await comp(user, {});
		const revoked = await api(user, "DELETE", `/newsletters/${user.slug}/comps/press@example.net`);
		assert.deepEqual([revoked.body.revoked], [true]);
		const contact = await readerOf(m, user, "press@example.net");
		assert.deepEqual([contact.tier, contact.grant, contact.status], ["free", undefined, "active"]);
		assert.equal((await api(user, "DELETE", `/newsletters/${user.slug}/comps/press@example.net`)).body.revoked, false);
		assert.equal((await api(user, "GET", `/newsletters/${user.slug}/comps`)).body.comps.length, 0);
	});
});

describe("a comp beside a Stripe subscription", () => {
	test("a paying reader stays as they pay, and the comp holds after the subscription ends", async () => {
		const user = await compSeller();
		await addReader(m, user, "both@example.net");
		const paid = await subscribe(user, { option: "month", email: "both@example.net" });
		const { subscription } = await completeCheckout(fake, user, paid.url, { email: "both@example.net" });
		const periodEnd = (await readerOf(m, user, "both@example.net")).paidUntil;

		const response = await comp(user, { contact: "both@example.net", endsAt: inDays(90) });
		assert.equal(response.body.alsoPays, true);
		let contact = await readerOf(m, user, "both@example.net");
		assert.equal(contact.paidUntil.getTime(), periodEnd.getTime(), "Stripe's period still says");
		assert.equal(contact.paidInterval, "month");
		assert.equal(contact.grant.kind, "comp");
		const [row] = (await api(user, "GET", `/newsletters/${user.slug}/tiers`)).body.tiers;
		assert.deepEqual([row.readers.paying, row.readers.comp], [1, 0], "counted as paying, not twice");

		fake.subscriptions.set(subscription.id, { ...subscription, status: "canceled" });
		const ended = await postPaymentEvent(fake.event("customer.subscription.deleted", { id: subscription.id, object: "subscription" }, { account: user.stripeAccountId }));
		assert.equal(ended.body.tier, "paid", "the comp holds");
		contact = await readerOf(m, user, "both@example.net");
		assert.equal(contact.tier, "paid");
		assert.equal(contact.paidInterval, undefined);
		assert.equal(contact.paidUntil.getTime(), new Date(contact.grant.until).getTime() - m.tiers.PAID_GRACE_MS);
		assert.equal((await api(user, "GET", "/contacts?tier=paid")).body.contacts.find(({ email }) => email === "both@example.net").paidAccess, "comp");
		assert.equal((await api(user, "GET", `/newsletters/${user.slug}/tiers`)).body.tiers[0].readers.comp, 1);
	});

	test("a comp reader who subscribes keeps one paid reader, now paying", async () => {
		const user = await compSeller();
		await comp(user, { endsAt: inDays(90) });
		const answer = await subscribe(user, { option: "year", email: "press@example.net" });
		assert.ok(answer.url, "a comp reader can still subscribe");
		const { subscription } = await completeCheckout(fake, user, answer.url, { email: "press@example.net", interval: "year" });
		const contact = await readerOf(m, user, "press@example.net");
		assert.deepEqual([contact.paidInterval, contact.stripeSubscriptionId, contact.grant.kind], ["year", subscription.id, "comp"]);
		assert.equal(contact.paidUntil.getTime(), subscription.current_period_end * 1000);
		assert.equal(await m.Contact.countDocuments({ accountId: user.accountId, email: "press@example.net" }), 1);
	});

	test("revoking leaves a paying reader paying", async () => {
		const user = await compSeller();
		await addReader(m, user, "both@example.net");
		const paid = await subscribe(user, { option: "month", email: "both@example.net" });
		await completeCheckout(fake, user, paid.url, { email: "both@example.net" });
		await comp(user, { contact: "both@example.net" });
		await api(user, "DELETE", `/newsletters/${user.slug}/comps/both@example.net`);
		const contact = await readerOf(m, user, "both@example.net");
		assert.deepEqual([contact.tier, contact.grant, contact.paidInterval], ["paid", undefined, "month"]);
	});
});
