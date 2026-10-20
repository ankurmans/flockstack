import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { anonymous, jsonRequest, startTestApp } from "./helpers/app.mjs";
import { DAY, addReader, addTier, completeCheckout, readerOf, sendIssue, setTier, skipJobs, subscribe } from "./helpers/paid.mjs";
import { WEBHOOK_SECRET, api, createSeller, installFakeStripe, postPaymentEvent } from "./helpers/shop.mjs";
import { runWithRequest } from "./stubs/next-headers.mjs";
import { published } from "./stubs/qstash.mjs";
import { sent as emails } from "./stubs/ses.mjs";

// A writer on the Free plan sells like any other: their readers pay their own Stripe account, so nothing here may ask for a
// paid FlockStack plan. Pledges, gifts, comps, offers and tiers, with the Free plan's "Sent with FlockStack" link on the website.
let app;
let m;
let fake;
let counter = 0;
let consumed = 0;

const seller = () => createSeller(`freeseller${++counter}@example.com`, { fake, free: true });
const inDays = (days) => new Date(Date.now() + days * DAY * 1000).toISOString();

async function render(page, props) {
	const element = await anonymous(() => page(props));
	return renderToStaticMarkup(createElement(m.ProviderSubscribe, { newsletter: { name: "Notes", slug: "notes" }, readers: 0 }, element));
}

async function renderPage(page, user, extra = {}) {
	return render(page, { params: Promise.resolve({ slug: user.slug, ...extra }) });
}

before(async () => {
	app = await startTestApp({ STRIPE_PAYMENTS_WEBHOOK_SECRET: WEBHOOK_SECRET, QSTASH_CURRENT_SIGNING_KEY: "sig-current", QSTASH_NEXT_SIGNING_KEY: "sig-next" });
	m = {
		sendBatchRoute: await import("../app/api/jobs/send-batch/route.js"),
		convertRoute: await import("../app/api/jobs/convert-pledges/route.js"),
		deliverRoute: await import("../app/api/jobs/deliver-gift/route.js"),
		subscribePage: (await import("../app/archive/[slug]/subscribe/page.js")).default,
		givePage: (await import("../app/archive/[slug]/give/page.js")).default,
		offerPage: (await import("../app/archive/[slug]/offer/[code]/page.js")).default,
		layout: (await import("../app/archive/[slug]/layout.js")).default,
		accountPage: (await import("../app/archive/[slug]/account/page.js")).default,
		giftActions: await import("../app/gift/actions.js"),
		pledgeActions: await import("../app/pledge/actions.js"),
		ProviderSubscribe: (await import("../components/ProviderSubscribe.jsx")).default,
		plans: await import("../lib/plans.js"),
		Account: (await import("../models/Account.js")).default,
		Contact: (await import("../models/Contact.js")).default,
		PledgeConversion: (await import("../models/PledgeConversion.js")).default,
		Pledge: (await import("../models/Pledge.js")).default,
	};
	skipJobs();
});

after(() => app?.stop());

beforeEach(() => {
	fake = installFakeStripe();
	skipJobs();
	consumed = published.length;
});

describe("a writer on the Free plan", () => {
	test("is on the Free plan, and sets up tiers, takes subscriptions and sends paid issues", async () => {
		const user = await seller();
		assert.equal(m.plans.isOnFreeTier(await m.Account.findById(user.accountId).lean()), true);
		await setTier(user);
		await addTier(user, { name: "Supporter", yearlyCents: 12000, founding: { enabled: true, cap: 5 } });
		const tiers = (await api(user, "GET", `/newsletters/${user.slug}/tiers`)).body.tiers;
		assert.equal(tiers.length, 2);

		const answer = await subscribe(user, { tier: tiers[1].id, option: "year", email: "paying@example.net" });
		assert.ok(answer.url);
		await completeCheckout(fake, user, answer.url, { email: "paying@example.net", interval: "year" });
		assert.equal((await readerOf(m, user, "paying@example.net")).paidTierId, tiers[1].id);
		skipJobs();
		const sent = await sendIssue(m, user, { audience: "paid", paidTier: tiers[1].id, subject: "For supporters" });
		assert.deepEqual(sent.emails.map(({ to }) => to), ["paying@example.net"]);
	});

	test("the website pages that sell carry the Sent with FlockStack link", async () => {
		const user = await seller();
		await setTier(user);
		await api(user, "PATCH", `/newsletters/${user.slug}/gifts`, { enabled: true });
		await api(user, "POST", `/newsletters/${user.slug}/offers`, { name: "Launch", type: "percent", percentOff: 20 });
		const layout = async (children) => renderToStaticMarkup(await anonymous(() => m.layout({ children, params: Promise.resolve({ slug: user.slug }) })));
		const html = await layout(null);
		assert.match(html, /Sent with FlockStack/);
		for (const [page, extra] of [[m.subscribePage], [m.givePage], [m.offerPage, { code: "launch" }]]) {
			assert.match(await renderPage(page, user, extra), /(Become a paid subscriber|Give a gift subscription|20% off)/);
		}
		const paid = await createSeller(`freeseller-paid${++counter}@example.com`, { fake });
		await setTier(paid);
		await addReader(m, paid, "someone@example.net");
		const paidHtml = renderToStaticMarkup(await anonymous(() => m.layout({ children: null, params: Promise.resolve({ slug: paid.slug }) })));
		assert.doesNotMatch(paidHtml, /Sent with FlockStack/, "a paid plan shows none unless it asks");
	});

	test("takes pledges, tells the pledgers and charges them", async () => {
		const user = await seller();
		await setTier(user, { enabled: false, monthlyCents: 800, yearlyCents: 8000 });
		assert.equal((await api(user, "PATCH", `/newsletters/${user.slug}/pledges`, { enabled: true })).status, 200);
		const actions = await import("../app/archive/shop-actions.js");
		const data = new FormData();
		for (const [key, value] of Object.entries({ newsletter: user.slug, option: "month", email: "pledger@example.net" })) data.set(key, value);
		const answer = await runWithRequest({ headers: { "x-forwarded-for": "192.0.2.201" } }, () => actions.pledgeSupport(null, data));
		assert.ok(answer.url, JSON.stringify(answer));
		const session = [...fake.sessions.values()].find((candidate) => candidate.url === answer.url);
		fake.completeSetup(session.id);
		await postPaymentEvent(fake.event("checkout.session.completed", session, { account: user.stripeAccountId }));
		assert.equal(await m.Pledge.countDocuments({ accountId: user.accountId, status: "active" }), 1);

		await setTier(user, { monthlyCents: undefined });
		const before = emails.length;
		const started = await api(user, "POST", `/newsletters/${user.slug}/pledges/charge`, { noticeDays: 1 });
		assert.equal(started.status, 200, JSON.stringify(started.body));
		const run = async () => {
			for (let step = 0; step < 6; step++) {
				const job = published.slice(consumed).find(({ url }) => url.endsWith("/api/jobs/convert-pledges"));
				if (!job) break;
				consumed = published.indexOf(job) + 1;
				await m.convertRoute.POST(jsonRequest(job.url, { method: "POST", body: job.body }));
			}
		};
		await run();
		assert.ok(emails.slice(before).some(({ to, subject }) => to === "pledger@example.net" && /will be charged on/.test(subject)), "the notice goes out from a Free account");
		await m.PledgeConversion.updateOne({ accountId: user.accountId, _id: started.body.id }, { $set: { chargeAt: new Date(Date.now() - 1000) } });
		consumed = published.length - 1;
		await run();
		assert.equal(fake.subscriptions.size, 1);
	});

	test("sells gifts, gives comps and makes offers", async () => {
		const user = await seller();
		await setTier(user);
		await addReader(m, user, "press@example.net");
		await api(user, "PATCH", `/newsletters/${user.slug}/gifts`, { enabled: true });
		const comp = await api(user, "POST", `/newsletters/${user.slug}/comps`, { contact: "press@example.net", endsAt: inDays(30) });
		assert.equal(comp.status, 201, JSON.stringify(comp.body));
		const offer = await api(user, "POST", `/newsletters/${user.slug}/offers`, { name: "Launch", type: "percent", percentOff: 20 });
		assert.equal(offer.status, 201);

		const actions = await import("../app/archive/shop-actions.js");
		const data = new FormData();
		for (const [key, value] of Object.entries({ newsletter: user.slug, months: 12, recipientEmail: "friend@example.net", buyerEmail: "buyer@example.net", deliverOn: new Date().toISOString().slice(0, 10) })) data.set(key, String(value));
		const bought = await runWithRequest({ headers: { "x-forwarded-for": "192.0.2.202" } }, () => actions.buyGift(null, data));
		assert.ok(bought.url, JSON.stringify(bought));
		const before = emails.length;
		const session = [...fake.sessions.values()].find((candidate) => candidate.url === bought.url);
		fake.paidSession(session.id, { customer: null, customer_details: { email: "buyer@example.net" }, payment_status: "paid" });
		await postPaymentEvent(fake.event("checkout.session.completed", session, { account: user.stripeAccountId }));
		const job = published.slice(consumed).find(({ url }) => url.endsWith("/api/jobs/deliver-gift"));
		const delivered = await m.deliverRoute.POST(jsonRequest(job.url, { method: "POST", body: job.body }));
		assert.equal((await delivered.json()).sent, true);
		const gift = emails.slice(before).find(({ to }) => to === "friend@example.net");
		assert.ok(gift, "the gift email goes out from a Free account");
		const token = new URL(/https?:\/\/[^\s"<>]+\/gift\?token=[A-Za-z0-9_.-]+/.exec(gift.text)[0]).searchParams.get("token");
		assert.equal((await anonymous(() => m.giftActions.redeem(token))).ok, true);
		assert.equal((await readerOf(m, user, "friend@example.net")).tier, "paid");
	});
});

describe("the hourly cron", () => {
	test("runs the paid features' jobs and the site's together", async () => {
		const FeedCache = (await import("../models/FeedCache.js")).default;
		const route = await import("../app/api/cron/hourly/route.js");
		const user = await seller();
		await setTier(user);
		await addReader(m, user, "press@example.net");
		await addReader(m, user, "friend@example.net");

		// A comp that ran out, a gift whose day came and a feed copy nobody read for two days.
		await api(user, "POST", `/newsletters/${user.slug}/comps`, { contact: "press@example.net", endsAt: inDays(5) });
		const contact = await readerOf(m, user, "press@example.net");
		await m.Contact.updateOne({ accountId: user.accountId, _id: contact._id }, { $set: { "grant.until": new Date(Date.now() - 1000), paidUntil: new Date(Date.now() - 1000 - 3 * DAY * 1000) } });
		await FeedCache.create({ accountId: user.accountId, key: "https://feeds.example.com/a.xml", fetchedAt: new Date(Date.now() - 2 * DAY * 1000) });
		await api(user, "PATCH", `/newsletters/${user.slug}/gifts`, { enabled: true });
		const actions = await import("../app/archive/shop-actions.js");
		const data = new FormData();
		for (const [key, value] of Object.entries({ newsletter: user.slug, months: 12, recipientEmail: "friend@example.net", buyerEmail: "buyer@example.net", deliverOn: new Date().toISOString().slice(0, 10) })) data.set(key, value);
		const bought = await runWithRequest({ headers: { "x-forwarded-for": "192.0.2.203" } }, () => actions.buyGift(null, data));
		const session = [...fake.sessions.values()].find((candidate) => candidate.url === bought.url);
		fake.paidSession(session.id, { customer: null, customer_details: { email: "buyer@example.net" }, payment_status: "paid" });
		await postPaymentEvent(fake.event("checkout.session.completed", session, { account: user.stripeAccountId }));

		process.env.CRON_SECRET = "cron-secret-for-tests";
		const before = emails.length;
		const response = await route.GET(new Request("http://localhost:3000/api/cron/hourly", { headers: { authorization: "Bearer cron-secret-for-tests" } }));
		assert.equal(response.status, 200);
		assert.equal((await readerOf(m, user, "press@example.net")).tier, "free", "the comp was cleared");
		assert.equal(await FeedCache.countDocuments({ accountId: user.accountId }), 0, "the old feed copy was purged");
		assert.ok(emails.slice(before).some(({ to }) => to === "friend@example.net"), "the gift was delivered");
	});
});

