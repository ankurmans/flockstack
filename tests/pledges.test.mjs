import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { anonymous, jsonRequest, startTestApp } from "./helpers/app.mjs";
import { DAY, addReader, addTier, runJobs, sendIssue, setTier, skipJobs, subscribe } from "./helpers/paid.mjs";
import { WEBHOOK_SECRET, api, assertError, createSeller, installFakeStripe, postPaymentEvent } from "./helpers/shop.mjs";
import { runWithRequest } from "./stubs/next-headers.mjs";
import { published } from "./stubs/qstash.mjs";
import { sent as emails } from "./stubs/ses.mjs";

// Pledges: a reader commits to a price and saves a card with a SetupIntent on the creator's Stripe account, and is not
// charged. Starting to charge tells every pledger first, then makes their subscriptions off-session, in steps that can be
// resumed and never charge anyone twice.
let app;
let m;
let fake;
let counter = 0;
let visitors = 0;
let consumed = 0;

const seller = (options = {}) => createSeller(`pledges${++counter}@example.com`, { fake, ...options });

// A seller whose paid tier isn't open: prices are set and pledges are on.
async function pledgeSeller(extra = {}) {
	const user = await seller();
	await setTier(user, { enabled: false, monthlyCents: 800, yearlyCents: 8000 });
	const settings = await api(user, "PATCH", `/newsletters/${user.slug}/pledges`, { enabled: true, ...extra });
	assert.equal(settings.status, 200, JSON.stringify(settings.body));
	return user;
}

async function pledge(user, fields = {}, { ip = `192.0.2.${(++visitors % 250) + 1}` } = {}) {
	const actions = await import("../app/archive/shop-actions.js");
	const data = new FormData();
	for (const [key, value] of Object.entries({ newsletter: user.slug, option: "month", email: "pledger@example.net", ...fields })) data.set(key, String(value));
	return runWithRequest({ headers: { "x-forwarded-for": ip } }, () => actions.pledgeSupport(null, data));
}

const sessionOf = (url) => [...fake.sessions.values()].find((candidate) => candidate.url === url);

// The pledger gives a card: Stripe completes the setup session and tells the webhook.
async function savedPledge(user, fields = {}) {
	const answer = await pledge(user, fields);
	assert.ok(answer.url, JSON.stringify(answer));
	const session = sessionOf(answer.url);
	const { method } = fake.completeSetup(session.id);
	const result = await postPaymentEvent(fake.event("checkout.session.completed", session, { account: user.stripeAccountId }));
	assert.equal(result.status, 200, JSON.stringify(result.body));
	return { session, method, result, pledge: await m.Pledge.findOne({ accountId: user.accountId, stripeSessionId: session.id }).lean() };
}

function cancelUrlIn(email) {
	return /https?:\/\/[^\s"<>]+\/pledge\?token=[A-Za-z0-9_.-]+/.exec(email.text)?.[0];
}

const jobs = () => published.slice(consumed).filter(({ url }) => url.endsWith("/api/jobs/convert-pledges"));

async function runStep(body) {
	const response = await m.jobRoute.POST(jsonRequest("http://localhost:3000/api/jobs/convert-pledges", { method: "POST", body }));
	return { status: response.status, ...(await response.json()) };
}

// Runs the latest job and each one it publishes, until none is left.
async function runConversion({ maxSteps = 20 } = {}) {
	const results = [];
	for (let step = 0; step < maxSteps; step++) {
		const next = jobs()[0];
		if (!next) break;
		consumed = published.indexOf(next) + 1;
		results.push(await runStep(next.body));
	}
	return results;
}

async function startCharging(user, body = {}) {
	const response = await api(user, "POST", `/newsletters/${user.slug}/pledges/charge`, body);
	assert.equal(response.status, 200, JSON.stringify(response.body));
	return response.body;
}

async function openPaidTier(user) {
	await setTier(user, { monthlyCents: undefined, yearlyCents: undefined });
}

// Stripe tells the webhook about a subscription the conversion made.
async function announce(user, subscription) {
	return postPaymentEvent(fake.event("customer.subscription.created", { id: subscription.id, object: "subscription" }, { account: user.stripeAccountId }));
}

async function render(page, user) {
	const element = await anonymous(() => page({ params: Promise.resolve({ slug: user.slug }) }));
	return renderToStaticMarkup(createElement(m.ProviderSubscribe, { newsletter: { name: "Notes", slug: "notes" }, readers: 0 }, element));
}

before(async () => {
	app = await startTestApp({ STRIPE_PAYMENTS_WEBHOOK_SECRET: WEBHOOK_SECRET, QSTASH_CURRENT_SIGNING_KEY: "sig-current", QSTASH_NEXT_SIGNING_KEY: "sig-next" });
	m = {
		jobRoute: await import("../app/api/jobs/convert-pledges/route.js"),
		sendBatchRoute: await import("../app/api/jobs/send-batch/route.js"),
		cronRoute: await import("../app/api/cron/hourly/route.js"),
		subscribePage: (await import("../app/archive/[slug]/subscribe/page.js")).default,
		pledgePage: (await import("../app/pledge/page.js")).default,
		pledgeActions: await import("../app/pledge/actions.js"),
		ProviderSubscribe: (await import("../components/ProviderSubscribe.jsx")).default,
		links: await import("../lib/paid-links.js"),
		conversion: await import("../lib/pledge-conversion.js"),
		Contact: (await import("../models/Contact.js")).default,
		Pledge: (await import("../models/Pledge.js")).default,
		PledgeConversion: (await import("../models/PledgeConversion.js")).default,
		Suppression: (await import("../models/Suppression.js")).default,
	};
	skipJobs();
	consumed = published.length;
});

after(() => app?.stop());

beforeEach(() => {
	fake = installFakeStripe();
	skipJobs();
	consumed = published.length;
});

describe("turning pledges on", () => {
	test("needs a tier with a price and a Stripe account that takes payments, and sets the notice days", async () => {
		const user = await seller();
		const noTier = await api(user, "PATCH", `/newsletters/${user.slug}/pledges`, { enabled: true });
		assert.match(assertError(noTier, 400, "validation_failed"), /paid tier with a price/);
		await setTier(user, { enabled: false, monthlyCents: 800, yearlyCents: 8000 });
		const on = await api(user, "PATCH", `/newsletters/${user.slug}/pledges`, { enabled: true });
		assert.deepEqual([on.body.enabled, on.body.open, on.body.noticeDays], [true, true, 7], "7 days by default");
		assert.match(on.body.subscribeUrl, /\/subscribe$/);
		const days = await api(user, "PATCH", `/newsletters/${user.slug}/pledges`, { noticeDays: 14 });
		assert.deepEqual([days.body.enabled, days.body.noticeDays], [true, 14], "the rest stays");
		assertError(await api(user, "PATCH", `/newsletters/${user.slug}/pledges`, { noticeDays: 0 }), 400, "validation_failed");
		assertError(await api(user, "PATCH", `/newsletters/${user.slug}/pledges`, { noticeDays: 31 }), 400, "validation_failed");

		const unready = await seller({ ready: false });
		await setTier(unready, { enabled: false, monthlyCents: 800 });
		assertError(await api(unready, "PATCH", `/newsletters/${unready.slug}/pledges`, { enabled: true }), 409, "payments_not_ready");
	});

	test("the subscribe page says plainly that nothing is charged now, and closes once the paid tier opens", async () => {
		const user = await pledgeSeller();
		const page = await render(m.subscribePage, user);
		assert.match(page, /Pledge your support/);
		assert.match(page, /Pledge, no charge today/);
		assert.match(page, /You won(?:'|&#x27;)t be charged now/);
		assert.match(page, /link to cancel/);
		assert.doesNotMatch(page, /Continue to payment/);

		await openPaidTier(user);
		const paid = await render(m.subscribePage, user);
		assert.match(paid, /Become a paid subscriber/);
		assert.deepEqual(await pledge(user), { error: "Paid subscriptions are open now: subscribe instead" });
		await api(user, "PATCH", `/newsletters/${user.slug}/paid-tier`, { enabled: false });
		await api(user, "PATCH", `/newsletters/${user.slug}/pledges`, { enabled: false });
		assert.equal(await render(m.subscribePage, user).catch((error) => error.message), "NEXT_NOT_FOUND");
	});
});

describe("pledging", () => {
	test("saves a card with a setup session on the creator's account, charges nothing and gives no paid access", async () => {
		const user = await pledgeSeller();
		const { session, method, pledge: saved } = await savedPledge(user, { option: "year", email: "Ada@Example.net" });
		assert.equal(session.mode, "setup");
		assert.equal(session.line_items, undefined, "no price, no charge");
		assert.equal(session.subscription_data, undefined);
		assert.equal(session.connectedAccount, user.stripeAccountId);
		assert.deepEqual(session.payment_method_types, ["card"]);
		assert.equal(session.metadata.kind, "pledge");
		assert.match(session.custom_text.submit.message, /won't be charged today/);
		assert.equal(session.success_url, `https://${user.slug}.flockstackmail.com/subscribe?pledged=1`);
		const customerCall = fake.requests.find(({ path }) => path === "/v1/customers");
		assert.equal(customerCall.account, user.stripeAccountId);
		assert.equal(customerCall.params.email, "ada@example.net");

		assert.deepEqual([saved.status, saved.option, saved.amountCents, saved.currency, saved.email], ["active", "year", 8000, "usd", "ada@example.net"]);
		assert.equal(saved.paymentMethodId, method.id);
		assert.ok(saved.setupIntentId);
		assert.equal(fake.subscriptions.size, 0, "no subscription");
		assert.ok(!fake.requests.some(({ path }) => path === "/v1/subscriptions" || path === "/v1/payment_intents" || path === "/v1/invoices"), "nothing charged");
		assert.doesNotMatch(JSON.stringify(fake.requests), /application_fee/i);

		const contact = await m.Contact.findOne({ accountId: user.accountId, email: "ada@example.net" }).lean();
		assert.deepEqual([contact.status, contact.source, contact.tier ?? "free"], ["active", "pledge", "free"], "a free subscriber");
		assert.equal(contact.paidUntil, undefined);
	});

	test("emails the pledger that nothing was charged, with a link to cancel", async () => {
		const user = await pledgeSeller({ noticeDays: 10 });
		const before = emails.length;
		await savedPledge(user);
		const confirmation = emails.slice(before).filter(({ subject }) => /You pledged/.test(subject)).at(-1);
		assert.ok(confirmation, "a confirmation");
		assert.match(confirmation.text, /\$8\.00 a month/);
		assert.match(confirmation.text, /haven't been charged/);
		assert.match(confirmation.text, /10 days before the first charge/);
		assert.ok(cancelUrlIn(confirmation));
		assert.doesNotMatch(confirmation.html, /Unsubscribe/i, "a message about what the reader did");
	});

	test("takes the price from the tier, never the form, and only monthly or yearly", async () => {
		const user = await pledgeSeller();
		await addTier(user, { name: "Patron", lifetimeCents: 30000, quarterlyCents: 2000 });
		const patron = (await api(user, "GET", `/newsletters/${user.slug}/tiers`)).body.tiers.find(({ name }) => name === "Patron");
		const none = "This newsletter doesn't offer that plan";
		assert.deepEqual(await pledge(user, { tier: patron.id, option: "month" }), { error: none });
		assert.deepEqual(await pledge(user, { option: "lifetime" }), { error: "Pick monthly or yearly" });
		assert.deepEqual(await pledge(user, { tier: "t_missing" }), { error: none });
		assert.deepEqual(await pledge(user, { email: "nope" }), { error: "Enter a valid email" });
		assert.deepEqual(await pledge(user, { website: "bot" }), { error: "This newsletter doesn't take pledges" });
		await pledge(user, { amountCents: "1", amount: "1", unit_amount: "1" });
		assert.equal((await m.Pledge.findOne({ accountId: user.accountId }).lean()).amountCents, 800);
	});

	test("refuses a second pledge from the same address, a paid subscriber and too many from one network", async () => {
		const user = await pledgeSeller();
		await savedPledge(user, { email: "once@example.net" });
		assert.match((await pledge(user, { email: "once@example.net" })).error, /already pledged/);
		await addReader(m, user, "paid@example.net", { tier: "paid", paidUntil: new Date(Date.now() + 20 * DAY * 1000) });
		assert.match((await pledge(user, { email: "paid@example.net" })).error, /already a paid subscriber/);
		const results = [];
		for (let count = 0; count < 11; count++) results.push(await pledge(user, { email: `many${count}@example.net` }, { ip: "198.51.100.77" }));
		assert.equal(results.filter(({ url }) => url).length, 10 - 0);
		assert.match(results.at(-1).error, /Too many attempts/);
	});

	test("a pledge whose card was never saved is not counted", async () => {
		const user = await pledgeSeller();
		const answer = await pledge(user, { email: "abandoned@example.net" });
		assert.ok(answer.url);
		const report = await api(user, "GET", `/newsletters/${user.slug}/pledges/report`);
		assert.equal(report.body.pledges, 0);
		assert.deepEqual((await api(user, "GET", `/newsletters/${user.slug}/pledges`)).body.pledges, []);
	});

	test("a repeated webhook changes nothing and sends one confirmation", async () => {
		const user = await pledgeSeller();
		const before = emails.length;
		const { session } = await savedPledge(user);
		const again = await postPaymentEvent(fake.event("checkout.session.completed", session, { account: user.stripeAccountId }));
		assert.equal(again.status, 200);
		assert.equal(emails.slice(before).filter(({ subject }) => /You pledged/.test(subject)).length, 1);
		assert.equal(await m.Pledge.countDocuments({ accountId: user.accountId, status: "active" }), 1);
	});
});

describe("the pledge report", () => {
	test("counts pledges and totals them per tier, monthly and yearly apart", async () => {
		const user = await pledgeSeller();
		await addTier(user, { name: "Supporter", monthlyCents: 2000, yearlyCents: 12000 });
		const supporter = (await api(user, "GET", `/newsletters/${user.slug}/tiers`)).body.tiers.find(({ name }) => name === "Supporter");
		await savedPledge(user, { email: "a@example.net", option: "month" });
		await savedPledge(user, { email: "b@example.net", option: "year" });
		await savedPledge(user, { email: "c@example.net", tier: supporter.id, option: "month" });
		await savedPledge(user, { email: "d@example.net", tier: supporter.id, option: "year" });
		const { body } = await api(user, "GET", `/newsletters/${user.slug}/pledges/report`);
		assert.equal(body.pledges, 4);
		const byName = Object.fromEntries(body.tiers.map((tier) => [tier.name, tier]));
		assert.deepEqual([byName["Paid subscription"].pledges, byName["Paid subscription"].monthlyCents, byName["Paid subscription"].yearlyCents, byName["Paid subscription"].perMonthCents], [2, 800, 8000, 800 + 667]);
		assert.deepEqual([byName.Supporter.pledges, byName.Supporter.monthlyCents, byName.Supporter.yearlyCents, byName.Supporter.perMonthCents], [2, 2000, 12000, 3000]);
		assert.equal(body.perMonthCents, 800 + 667 + 3000);
		assert.equal(body.currency, "usd");
		assert.equal(body.settings.enabled, true);

		const list = await api(user, "GET", `/newsletters/${user.slug}/pledges`, undefined);
		assert.equal(list.body.pledges.length, 4);
		assert.deepEqual(list.body.pledges.map(({ email }) => email).sort(), ["a@example.net", "b@example.net", "c@example.net", "d@example.net"]);
		const page = await api(user, "GET", `/newsletters/${user.slug}/pledges?limit=3`);
		assert.equal(page.body.pledges.length, 3);
		assert.ok(page.body.nextCursor);
		assert.equal((await api(user, "GET", `/newsletters/${user.slug}/pledges?status=canceled`)).body.pledges.length, 0);
	});

	test("belongs to the newsletter's account only", async () => {
		const user = await pledgeSeller();
		const stranger = await seller();
		assertError(await api(stranger, "GET", `/newsletters/${user.slug}/pledges/report`), 404, "not_found");
	});
});

describe("canceling a pledge", () => {
	test("the pledger's link cancels it with one click, removes the saved card and can be used again", async () => {
		const user = await pledgeSeller();
		const before = emails.length;
		const { pledge: saved, method } = await savedPledge(user);
		const link = cancelUrlIn(emails.slice(before).find(({ subject }) => /You pledged/.test(subject)));
		const token = new URL(link).searchParams.get("token");

		const element = await anonymous(() => m.pledgePage({ searchParams: Promise.resolve({ token }) }));
		const markup = renderToStaticMarkup(element);
		assert.match(markup, /Cancel your pledge to/);
		assert.equal((await m.Pledge.findById(saved._id).setOptions({ crossAccount: true }).lean()).status, "active", "opening the page cancels nothing");

		const done = await anonymous(() => m.pledgeActions.cancelPledge(token));
		assert.deepEqual([done.ok, done.newsletterName], [true, `${user.slug} news`]);
		const canceled = await m.Pledge.findById(saved._id).setOptions({ crossAccount: true }).lean();
		assert.deepEqual([canceled.status, Boolean(canceled.canceledAt)], ["canceled", true]);
		assert.equal(fake.paymentMethods.get(method.id).customer, null, "the card is detached");
		assert.equal((await anonymous(() => m.pledgeActions.cancelPledge(token))).ok, true, "again is fine");
		assert.equal((await api(user, "GET", `/newsletters/${user.slug}/pledges/report`)).body.pledges, 0);
		const contact = await m.Contact.findOne({ accountId: user.accountId, email: "pledger@example.net" }).lean();
		assert.equal(contact.status, "active", "they stay on the free list");
	});

	test("refuses forged and mixed-up links", async () => {
		const user = await pledgeSeller();
		const { pledge: saved } = await savedPledge(user);
		const real = m.links.createPaidToken("pledge-cancel", { p: String(saved._id), n: String(user.newsletterId) });
		assert.equal((await anonymous(() => m.pledgeActions.cancelPledge(`${real.slice(0, -2)}xx`))).error, "invalid");
		assert.equal((await anonymous(() => m.pledgeActions.cancelPledge("garbage"))).error, "invalid");
		const wrongKind = m.links.createPaidToken("gift-redeem", { p: String(saved._id), n: String(user.newsletterId) });
		assert.equal((await anonymous(() => m.pledgeActions.cancelPledge(wrongKind))).error, "invalid");
		assert.equal(m.links.readPaidToken("pledge-cancel", real, Date.now() + 4 * 365 * DAY * 1000), null, "too old");
		const otherNewsletter = m.links.createPaidToken("pledge-cancel", { p: String(saved._id), n: "6650f1c2e9b1d4a012345678" });
		assert.equal((await anonymous(() => m.pledgeActions.cancelPledge(otherNewsletter))).error, "invalid");
		const page = renderToStaticMarkup(await anonymous(() => m.pledgePage({ searchParams: Promise.resolve({ token: "nope" }) })));
		assert.match(page, /link doesn(?:'|&#x27;)t work/);
	});

	test("the writer can cancel a pledge too, but not one that is already a subscription", async () => {
		const user = await pledgeSeller();
		const { pledge: saved } = await savedPledge(user);
		const response = await api(user, "DELETE", `/pledges/${saved._id}`);
		assert.equal(response.body.status, "canceled");
		assertError(await api(user, "DELETE", `/pledges/6650f1c2e9b1d4a012345678`), 404, "not_found");
		const second = await savedPledge(user, { email: "second@example.net" });
		await m.Pledge.updateOne({ accountId: user.accountId, _id: second.pledge._id }, { $set: { status: "converted" } });
		assertError(await api(user, "DELETE", `/pledges/${second.pledge._id}`), 409, "conflict");
	});
});

describe("start charging", () => {
	async function pledgers(user, count = 3) {
		const saved = [];
		for (let index = 0; index < count; index++) saved.push(await savedPledge(user, { email: `p${index}@example.net`, option: index === 1 ? "year" : "month" }));
		return saved;
	}

	test("needs the paid tier on, pledges to charge and no other charging running", async () => {
		const user = await pledgeSeller();
		assert.match(assertError(await api(user, "POST", `/newsletters/${user.slug}/pledges/charge`, {}), 409, "conflict"), /Turn on the paid tier first/);
		await openPaidTier(user);
		assert.match(assertError(await api(user, "POST", `/newsletters/${user.slug}/pledges/charge`, {}), 409, "conflict"), /no pledges to charge/);
		await api(user, "PATCH", `/newsletters/${user.slug}/paid-tier`, { enabled: false });
		await pledgers(user, 1);
		await openPaidTier(user);
		assertError(await api(user, "POST", `/newsletters/${user.slug}/pledges/charge`, { tier: "Nobody" }), 400, "validation_failed");
		const started = await startCharging(user);
		assert.deepEqual([started.status, started.noticeDays, started.total, started.honorPledgedPrice], ["notifying", 7, 1, true]);
		assert.match(assertError(await api(user, "POST", `/newsletters/${user.slug}/pledges/charge`, {}), 409, "conflict"), /already being charged/);
	});

	test("tells every pledger the day of the first charge before anything is charged", async () => {
		const user = await pledgeSeller({ noticeDays: 3 });
		await pledgers(user);
		await openPaidTier(user);
		const before = emails.length;
		const started = await startCharging(user);
		assert.equal(started.noticeDays, 3, "the newsletter's setting");
		const day = new Date(started.chargeAt);
		assert.ok(Math.abs(day.getTime() - (Date.now() + 3 * DAY * 1000)) < 60_000);

		const results = await runConversion({ maxSteps: 1 });
		assert.equal(results[0].continued ?? results[0].waiting, true);
		const notices = emails.slice(before).filter(({ subject }) => /will be charged on/.test(subject));
		assert.deepEqual(notices.map(({ to }) => to).sort(), ["p0@example.net", "p1@example.net", "p2@example.net"]);
		const long = day.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
		for (const notice of notices) {
			assert.match(notice.subject, new RegExp(long));
			assert.match(notice.text, /Cancel your pledge/);
			assert.ok(cancelUrlIn(notice));
		}
		assert.match(notices.find(({ to }) => to === "p1@example.net").text, /\$80\.00 a year/);
		assert.equal(fake.subscriptions.size, 0, "nobody is charged yet");
		assert.equal(await m.Pledge.countDocuments({ accountId: user.accountId, status: "scheduled" }), 3);
		const state = await api(user, "GET", `/newsletters/${user.slug}/pledges/charging`);
		assert.equal(state.body.charging.status, "waiting");
		assert.equal(state.body.charging.notified, 3);
	});

	test("waits for the charge day, republishing itself, then makes one subscription per pledger off-session", async () => {
		const user = await pledgeSeller();
		await pledgers(user);
		await openPaidTier(user);
		const started = await startCharging(user, { noticeDays: 2 });
		await runConversion();
		const waiting = published.at(-1);
		assert.equal(waiting.url.endsWith("/api/jobs/convert-pledges"), true);
		const delay = waiting.notBefore * 1000 - Date.now();
		assert.ok(delay > 1.9 * DAY * 1000 && delay <= 2 * DAY * 1000 + 5000, "delayed until the charge day");
		assert.equal(fake.subscriptions.size, 0);

		await m.PledgeConversion.updateOne({ accountId: user.accountId, _id: started.id }, { $set: { chargeAt: new Date(Date.now() - 1000) } });
		consumed = published.length - 1;
		const results = await runConversion();
		assert.equal(results.at(-1).done, true);
		assert.deepEqual([results.at(-1).converted, results.at(-1).failed], [3, 0]);
		assert.equal(fake.subscriptions.size, 3);
		for (const subscription of fake.subscriptions.values()) {
			assert.equal(subscription.off_session, "true");
			assert.equal(subscription.payment_behavior, "error_if_incomplete");
			assert.equal(subscription.metadata.kind, "paid_tier");
			assert.ok(subscription.metadata.pledgeId);
			assert.ok(fake.paymentMethods.get(subscription.default_payment_method));
		}
		const requests = fake.requests.filter(({ method, path }) => method === "POST" && path === "/v1/subscriptions");
		assert.ok(requests.every(({ account }) => account === user.stripeAccountId));
		assert.ok(requests.every(({ idempotencyKey }) => /^flockstack-pledge-subscription-/.test(idempotencyKey)));
		assert.doesNotMatch(JSON.stringify(fake.requests), /application_fee/i);

		const pledges = await m.Pledge.find({ accountId: user.accountId }).lean();
		assert.ok(pledges.every(({ status, subscriptionId }) => status === "converted" && subscriptionId));
		const final = (await api(user, "GET", `/newsletters/${user.slug}/pledges/charging`)).body.charging;
		assert.deepEqual([final.status, final.notified, final.converted, final.failed], ["done", 3, 3, 0]);
	});

	test("pledgers get paid access only once charged: the webhook makes them paid readers of their tier", async () => {
		const user = await pledgeSeller();
		const [first] = await pledgers(user, 2);
		await openPaidTier(user);
		skipJobs();
		const draft = await api(user, "POST", "/campaigns", { subject: "Before charging", content: "Hi", audience: "paid" });
		assert.equal((await api(user, "GET", `/campaigns/${draft.body.id}`)).body.audienceSize, 0, "no paid access while only pledged");
		const contact = await m.Contact.findOne({ accountId: user.accountId, email: "p0@example.net" }).lean();
		assert.notEqual(contact.tier, "paid");

		const started = await startCharging(user, { noticeDays: 1 });
		await runConversion();
		await m.PledgeConversion.updateOne({ accountId: user.accountId, _id: started.id }, { $set: { chargeAt: new Date(Date.now() - 1000) } });
		consumed = published.length - 1;
		await runConversion();
		const [subscription] = [...fake.subscriptions.values()].filter(({ customer }) => customer === first.pledge.stripeCustomerId);
		assert.equal((await announce(user, subscription)).body.tier, "paid");
		const paid = await m.Contact.findOne({ accountId: user.accountId, email: "p0@example.net" }).lean();
		assert.deepEqual([paid.tier, paid.paidTierId, paid.paidInterval, paid.stripeSubscriptionId], ["paid", "paid", "month", subscription.id]);
		assert.equal(await m.Contact.countDocuments({ accountId: user.accountId, email: "p0@example.net" }), 1, "one contact");
		skipJobs();
		const afterIssue = await sendIssue(m, user, { audience: "paid", subject: "After charging" });
		assert.deepEqual(afterIssue.emails.map(({ to }) => to), ["p0@example.net"]);
	});

	test("charges what each pledged, or the tier's price now when asked", async () => {
		const user = await pledgeSeller();
		await savedPledge(user, { email: "early@example.net", option: "month" });
		await setTier(user, { enabled: true, monthlyCents: 1200 });
		const started = await startCharging(user, { noticeDays: 1 });
		await runConversion();
		await m.PledgeConversion.updateOne({ accountId: user.accountId, _id: started.id }, { $set: { chargeAt: new Date(Date.now() - 1000) } });
		consumed = published.length - 1;
		await runConversion();
		const [honored] = [...fake.subscriptions.values()];
		assert.equal(honored.items.data[0].price.unit_amount, "800", "the pledged $8, not the new $12");
		assert.equal(honored.items.data[0].price.product, (await api(user, "GET", `/newsletters/${user.slug}/tiers`)).body.tiers[0].stripeProductId);

		const other = await pledgeSeller();
		await savedPledge(other, { email: "early@example.net", option: "month" });
		await setTier(other, { enabled: true, monthlyCents: 1200 });
		const second = await startCharging(other, { noticeDays: 1, honorPledgedPrice: false });
		await runConversion();
		await m.PledgeConversion.updateOne({ accountId: other.accountId, _id: second.id }, { $set: { chargeAt: new Date(Date.now() - 1000) } });
		consumed = published.length - 1;
		await runConversion();
		const current = [...fake.subscriptions.values()].at(-1);
		assert.equal(fake.prices.get(current.items.data[0].price.id).unit_amount, "1200");
	});

	test("a pledger who cancels after the notice is not charged", async () => {
		const user = await pledgeSeller();
		const saved = await pledgers(user);
		await openPaidTier(user);
		const before = emails.length;
		const started = await startCharging(user, { noticeDays: 1 });
		await runConversion();
		const notice = emails.slice(before).find(({ to }) => to === "p1@example.net");
		const token = new URL(cancelUrlIn(notice)).searchParams.get("token");
		assert.equal((await anonymous(() => m.pledgeActions.cancelPledge(token))).ok, true);

		await m.PledgeConversion.updateOne({ accountId: user.accountId, _id: started.id }, { $set: { chargeAt: new Date(Date.now() - 1000) } });
		consumed = published.length - 1;
		const results = await runConversion();
		assert.deepEqual([results.at(-1).converted, results.at(-1).failed], [2, 0]);
		const customers = [...fake.subscriptions.values()].map(({ customer }) => customer).sort();
		assert.deepEqual(customers, [saved[0].pledge.stripeCustomerId, saved[2].pledge.stripeCustomerId].sort());
		assert.equal((await m.Pledge.findOne({ accountId: user.accountId, _id: saved[1].pledge._id }).lean()).status, "canceled");
	});

	test("a refused card is marked failed, the pledger is told, and the others are charged", async () => {
		const user = await pledgeSeller();
		const saved = await pledgers(user);
		await openPaidTier(user);
		fake.declineCard(saved[1].method.id, "Your card has insufficient funds.");
		const started = await startCharging(user, { noticeDays: 1 });
		await runConversion();
		await m.PledgeConversion.updateOne({ accountId: user.accountId, _id: started.id }, { $set: { chargeAt: new Date(Date.now() - 1000) } });
		consumed = published.length - 1;
		const before = emails.length;
		const results = await runConversion();
		assert.deepEqual([results.at(-1).converted, results.at(-1).failed], [2, 1]);
		const failed = await m.Pledge.findOne({ accountId: user.accountId, _id: saved[1].pledge._id }).lean();
		assert.equal(failed.status, "failed");
		assert.match(failed.failure, /insufficient funds/);
		const email = emails.slice(before).find(({ to }) => to === "p1@example.net");
		assert.match(email.subject, /couldn't be charged/);
		assert.match(email.text, /subscribe here/);
		assert.equal((await api(user, "GET", `/newsletters/${user.slug}/pledges?status=failed`)).body.pledges.length, 1);
	});

	test("a pledger whose notice can't be emailed is not charged", async () => {
		const user = await pledgeSeller();
		const saved = await pledgers(user, 2);
		await m.Suppression.create({ accountId: user.accountId, email: "p0@example.net", reason: "bounce" });
		await openPaidTier(user);
		const started = await startCharging(user, { noticeDays: 1 });
		await runConversion();
		const first = await m.Pledge.findOne({ accountId: user.accountId, _id: saved[0].pledge._id }).lean();
		assert.equal(first.status, "failed");
		assert.match(first.failure, /notice couldn't be emailed/);
		await m.PledgeConversion.updateOne({ accountId: user.accountId, _id: started.id }, { $set: { chargeAt: new Date(Date.now() - 1000) } });
		consumed = published.length - 1;
		const results = await runConversion();
		assert.deepEqual([results.at(-1).converted, results.at(-1).failed], [1, 1]);
		assert.equal(fake.subscriptions.size, 1);
	});

	test("stopping before the charge day puts everyone back to pledged and charges nobody", async () => {
		const user = await pledgeSeller();
		await pledgers(user);
		await openPaidTier(user);
		const started = await startCharging(user, { noticeDays: 5 });
		await runConversion();
		assert.equal(await m.Pledge.countDocuments({ accountId: user.accountId, status: "scheduled" }), 3);
		const stopped = await api(user, "POST", `/newsletters/${user.slug}/pledges/charging/stop`, {});
		assert.equal(stopped.body.status, "canceled");
		assert.equal(await m.Pledge.countDocuments({ accountId: user.accountId, status: "active" }), 3);

		await m.PledgeConversion.updateOne({ accountId: user.accountId, _id: started.id }, { $set: { chargeAt: new Date(Date.now() - 1000) } });
		consumed = published.length - 1;
		const results = await runConversion();
		assert.equal(results.at(-1).skipped, "canceled");
		assert.equal(fake.subscriptions.size, 0);
		assertError(await api(user, "POST", `/newsletters/${user.slug}/pledges/charging/stop`, {}), 409, "conflict");
		const again = await startCharging(user, { noticeDays: 1 });
		assert.equal(again.total, 3, "it can be started again");
	});
});

describe("resuming and repeating", () => {
	async function scheduledPledges(user, count = 3) {
		const saved = [];
		for (let index = 0; index < count; index++) saved.push(await savedPledge(user, { email: `r${index}@example.net` }));
		await openPaidTier(user);
		const started = await startCharging(user, { noticeDays: 1 });
		await runConversion();
		await m.PledgeConversion.updateOne({ accountId: user.accountId, _id: started.id }, { $set: { chargeAt: new Date(Date.now() - 1000) } });
		consumed = published.length - 1;
		return { saved, started };
	}

	test("running the same step again makes no second subscription", async () => {
		const user = await pledgeSeller();
		const { started } = await scheduledPledges(user);
		await runConversion();
		assert.equal(fake.subscriptions.size, 3);
		const again = await runStep({ accountId: String(user.accountId), conversionId: started.id });
		assert.equal(again.skipped, "done");
		assert.equal(fake.subscriptions.size, 3);
		assert.equal(fake.requests.filter(({ method, path }) => method === "POST" && path === "/v1/subscriptions").length, 3);
	});

	test("a step that fails part way is retried from where it stopped, charging nobody twice", async () => {
		const user = await pledgeSeller();
		const { saved, started } = await scheduledPledges(user);
		let calls = 0;
		const original = globalThis.fetch;
		globalThis.fetch = async (input, init) => {
			if (String(input?.url ?? input).endsWith("/v1/subscriptions") && init?.method === "POST" && ++calls === 2) return Response.json({ error: { message: "Stripe is having a bad day", type: "api_error" } }, { status: 500 });
			return original(input, init);
		};
		try {
			const [job] = jobs();
			consumed = published.indexOf(job) + 1;
			await assert.rejects(runStep(job.body));
		} finally {
			globalThis.fetch = original;
		}
		assert.equal(fake.subscriptions.size, 1, "the first was charged");
		const statuses = (await m.Pledge.find({ accountId: user.accountId }).sort({ _id: 1 }).lean()).map(({ status }) => status);
		assert.deepEqual(statuses, ["converted", "charging", "scheduled"]);
		const retried = await runStep({ accountId: String(user.accountId), conversionId: started.id });
		assert.equal(retried.done, true);
		assert.equal(fake.subscriptions.size, 3, "one each");
		assert.deepEqual([...fake.subscriptions.values()].map(({ metadata }) => metadata.pledgeId).sort(), saved.map(({ pledge }) => String(pledge._id)).sort());
	});

	test("a subscription Stripe made just before a crash is found, not made again", async () => {
		const user = await pledgeSeller();
		const { saved, started } = await scheduledPledges(user, 1);
		const [only] = saved;
		const lost = fake.addSubscription({ customer: only.pledge.stripeCustomerId, metadata: { flockstack: "1", kind: "paid_tier", pledgeId: String(only.pledge._id) } });
		await m.Pledge.updateOne({ accountId: user.accountId, _id: only.pledge._id }, { $set: { status: "charging", chargingAt: new Date(Date.now() - 3_600_000) } });
		const result = await runStep({ accountId: String(user.accountId), conversionId: started.id });
		assert.equal(result.done, true);
		assert.equal(fake.subscriptions.size, 1);
		const pledge = await m.Pledge.findOne({ accountId: user.accountId, _id: only.pledge._id }).lean();
		assert.deepEqual([pledge.status, pledge.subscriptionId], ["converted", lost.id]);
	});

	test("a job delivered while another runs answers busy", async () => {
		const user = await pledgeSeller();
		const { started } = await scheduledPledges(user, 1);
		await m.PledgeConversion.updateOne({ accountId: user.accountId, _id: started.id }, { $set: { lockedUntil: new Date(Date.now() + 60_000) } });
		const busy = await runStep({ accountId: String(user.accountId), conversionId: started.id });
		assert.deepEqual([busy.status, busy.busy], [503, true]);
		assert.deepEqual(await runStep({ accountId: "nope", conversionId: "nope" }), { status: 200, skipped: "invalid job" });
	});

	test("the third failure in a row fails the conversion, and nothing is charged twice", async () => {
		const user = await pledgeSeller();
		const { started } = await scheduledPledges(user, 1);
		const original = globalThis.fetch;
		globalThis.fetch = async (input, init) => (String(input?.url ?? input).includes("/v1/subscriptions") ? Response.json({ error: { message: "down", type: "api_error" } }, { status: 500 }) : original(input, init));
		try {
			for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(runStep({ accountId: String(user.accountId), conversionId: started.id }));
			const last = await runStep({ accountId: String(user.accountId), conversionId: started.id });
			assert.match(last.failed, /Stripe answered 500/);
		} finally {
			globalThis.fetch = original;
		}
		const conversion = await m.PledgeConversion.findOne({ accountId: user.accountId, _id: started.id }).lean();
		assert.equal(conversion.status, "failed");
		assert.equal(fake.subscriptions.size, 0);
		const again = await startCharging(user, { noticeDays: 1 });
		assert.equal(again.id, started.id, "starting again carries on with the same conversion");
		consumed = published.length - 1;
		const results = await runConversion();
		assert.deepEqual([results.at(-1).done, results.at(-1).converted], [true, 1]);
		assert.equal(fake.subscriptions.size, 1);
	});

	test("the hourly cron gives a quiet conversion another job", async () => {
		const user = await pledgeSeller();
		await savedPledge(user);
		await openPaidTier(user);
		const started = await startCharging(user, { noticeDays: 1 });
		skipJobs();
		await m.PledgeConversion.updateOne({ accountId: user.accountId, _id: started.id }, { $set: { updatedAt: new Date(Date.now() - 3_600_000) } });
		const result = await m.conversion.resumeConversions();
		assert.ok(result.resumed >= 1);
		assert.equal(published.slice(-1)[0].url.endsWith("/api/jobs/convert-pledges"), true);
	});
});

test("pledge checkout, confirmation and first-charge notices follow all six publication languages", async () => {
	const { READER_LANGUAGES, getReaderText } = await import("../lib/reader-languages.js");
	const { formatReaderBillingDate } = await import("../lib/reader-billing-copy.js");
	const Newsletter = (await import("../models/Newsletter.js")).default;
	for (const language of READER_LANGUAGES) {
		consumed = published.length;
		const user = await pledgeSeller({ noticeDays: 3 });
		await Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { language } });
		const newsletter = await Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
		const t = getReaderText(newsletter), email = `locale-${language}@example.net`, before = emails.length;
		const saved = await savedPledge(user, { email, option: "year" });
		assert.equal(saved.session.custom_text.submit.message, t("You won't be charged today. Your card is saved, and charged only after {name} starts taking payments, with an email to you first.", { name: newsletter.name }));
		const confirmation = emails.slice(before).find((message) => message.subject === t("You pledged to support {name}", { name: newsletter.name }));
		assert.ok(confirmation, language); assert.ok(cancelUrlIn(confirmation));
		assert.ok(confirmation.text.includes(t("Cancel your pledge")), language);
		await openPaidTier(user);
		const conversion = await startCharging(user, { noticeDays: 3 });
		await runConversion({ maxSteps: 1 });
		const notice = emails.slice(before).find((message) => message.subject === t("Your pledge to {name} will be charged on {date}", { name: newsletter.name, date: formatReaderBillingDate(newsletter, conversion.chargeAt, { long: true }) }));
		assert.ok(notice, language); assert.ok(cancelUrlIn(notice));
		assert.ok(notice.text.includes(t("You don't have to do anything. If you've changed your mind, cancel before then and you won't be charged.")), language);
		if (language !== "en") assert.doesNotMatch(notice.text, /is now taking payments|every year|Cancel your pledge/);
	}
	assert.equal(fake.subscriptions.size, 0, "only notices, no charges");
});

test("failed-charge notices use the publication language while retaining the cancel-before-charge workflow", async () => {
	const { READER_LANGUAGES, getReaderText } = await import("../lib/reader-languages.js");
	const Newsletter = (await import("../models/Newsletter.js")).default;
	for (const language of READER_LANGUAGES) {
		consumed = published.length;
		const user = await pledgeSeller();
		await Newsletter.updateOne({ accountId: user.accountId, _id: user.newsletterId }, { $set: { language } });
		const newsletter = await Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
		const t = getReaderText(newsletter), email = `declined-${language}@example.net`;
		const saved = await savedPledge(user, { email });
		await openPaidTier(user); fake.declineCard(saved.method.id, "Synthetic declined card");
		const conversion = await startCharging(user, { noticeDays: 1 }); await runConversion();
		await m.PledgeConversion.updateOne({ accountId: user.accountId, _id: conversion.id }, { $set: { chargeAt: new Date(Date.now() - 1000) } });
		consumed = published.length - 1; const before = emails.length; await runConversion();
		const failed = emails.slice(before).find((message) => message.subject === t("Your pledge to {name} couldn't be charged", { name: newsletter.name }));
		assert.ok(failed, language); assert.ok(failed.text.includes(t("the bank refused it")), language);
		assert.match(failed.text, /\/subscribe/);
		assert.equal((await m.Pledge.findOne({ accountId: user.accountId, _id: saved.pledge._id }).lean()).status, "failed");
		if (language !== "en") assert.doesNotMatch(failed.text, /Your card was declined|the bank refused it|subscribe here/);
	}
});
