import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { startTestApp } from "./helpers/app.mjs";
import { SHARED_DOMAIN, addIssue, addReader, browser, createPublisher, importModels, inBrowser, signInReader } from "./helpers/community.mjs";

// What a signed-in reader gets on the website once a newsletter has paid tiers: the paid issues of their tier, and a Subscriber
// Center that says which tier they hold, how it is paid and any pledge they made.
let app;
let m;
let counter = 0;
const DAY_MS = 86_400_000;
const SECRET = "Only supporters read this line.";
const BODY = `<p>The free opening.</p><p>${SECRET}</p>`;

before(async () => {
	app = await startTestApp();
	m = {
		...(await importModels()),
		reader: await import("../app/archive/reader-actions.js"),
		accountPage: (await import("../app/archive/[slug]/account/page.js")).default,
		ProviderSubscribe: (await import("../components/ProviderSubscribe.jsx")).default,
		TooltipProvider: (await import("../components/ui/tooltip.jsx")).TooltipProvider,
		Account: (await import("../models/Account.js")).default,
		Pledge: (await import("../models/Pledge.js")).default,
	};
});

after(() => app?.stop());

const wrap = (user, element) =>
	renderToStaticMarkup(createElement(m.TooltipProvider, null, createElement(m.ProviderSubscribe, { newsletter: { name: "n", slug: user.slug, signupFields: [] }, readers: 0 }, element)));
const paidFields = (extra = {}) => ({ tier: "paid", paidUntil: new Date(Date.now() + 20 * DAY_MS), paidInterval: "month", stripeCustomerId: "cus_reader", stripeSubscriptionId: "sub_reader", subscriptionStatus: "active", ...extra });
const tier = (id, name, prices) => ({ id, name, description: "", benefits: [], prices: { month: 0, quarter: 0, year: 0, lifetime: 0, ...prices }, pwyw: { enabled: false }, founding: { enabled: false }, archived: false, stripe: {} });

async function tieredNewsletter(paidTier = {}) {
	const user = await createPublisher(m, `paidreader${++counter}@example.com`, { comments: { enabled: false } });
	await m.Newsletter.updateOne(
		{ accountId: user.accountId, _id: user.newsletterId },
		{ $set: { paidTier: { enabled: true, currency: "usd", monthlyCents: 800, yearlyCents: 8000, ...paidTier }, paidTiers: [tier("paid", "Paid subscription", { month: 800, year: 8000 }), tier("t_supporter", "Supporter", { year: 12000 })] } }
	);
	await m.Account.updateOne({ _id: user.accountId }, { $set: { "payments.stripeAccountId": `acct_${user.slug}`, "payments.chargesEnabled": true, "payments.payoutsEnabled": true, "payments.detailsSubmitted": true } });
	user.newsletter = await m.Newsletter.findOne({ accountId: user.accountId, _id: user.newsletterId }).lean();
	return user;
}

const unlock = (user, visitor, issue) => inBrowser(visitor, () => m.reader.unlockIssue(user.slug, issue.archiveSlug));
const visit = (user, visitor) => inBrowser(visitor, async () => wrap(user, await m.accountPage({ params: Promise.resolve({ slug: user.slug }) })));

describe("paid issues on the website", () => {
	test("open for the readers of the issue's tier and the tiers above it, and stay shut for the tiers below", async () => {
		const user = await tieredNewsletter();
		const forAll = await addIssue(m, user, { subject: "For every paid tier", audience: "paid", html: BODY });
		const forSupporters = await addIssue(m, user, { subject: "For supporters", audience: "paid", audienceMinTier: "t_supporter", audienceTiers: ["t_supporter"], html: BODY });
		const legacy = await addReader(m, user, "legacy@example.org", paidFields());
		const supporter = await addReader(m, user, "supporter@example.org", paidFields({ paidTierId: "t_supporter" }));

		const legacyBrowser = await signInReader(m, user, legacy);
		const supporterBrowser = await signInReader(m, user, supporter);
		assert.equal((await unlock(user, legacyBrowser, forAll)).unlocked, true, "any paid tier");
		assert.deepEqual(await unlock(user, legacyBrowser, forSupporters), { unlocked: false, signedIn: true }, "the lower tier");
		const open = await unlock(user, supporterBrowser, forSupporters);
		assert.equal(open.unlocked, true);
		assert.match(open.html, new RegExp(SECRET));
		assert.equal((await unlock(user, supporterBrowser, forAll)).unlocked, true);
	});

	test("open for a reader on a comp or a gift in the tier, and shut when it has run out", async () => {
		const user = await tieredNewsletter();
		const forSupporters = await addIssue(m, user, { subject: "For supporters", audience: "paid", audienceTiers: ["t_supporter"], html: BODY });
		const until = new Date(Date.now() + 10 * DAY_MS);
		const comp = await addReader(m, user, "comp@example.org", { tier: "paid", paidTierId: "t_supporter", paidUntil: new Date(until.getTime() - 3 * DAY_MS), grant: { kind: "comp", tierId: "t_supporter", until } });
		const visitor = await signInReader(m, user, comp);
		assert.equal((await unlock(user, visitor, forSupporters)).unlocked, true);
		await m.Contact.updateOne({ accountId: user.accountId, _id: comp._id }, { $set: { paidUntil: new Date(Date.now() - 4 * DAY_MS), "grant.until": new Date(Date.now() - DAY_MS) } });
		assert.equal((await unlock(user, visitor, forSupporters)).unlocked, false);
	});
});

describe("the Subscriber Center", () => {
	test("says which tier a reader holds and how it is billed", async () => {
		const user = await tieredNewsletter();
		const supporter = await addReader(m, user, "supporter@example.org", paidFields({ paidTierId: "t_supporter", paidInterval: "year" }));
		const page = await visit(user, await signInReader(m, user, supporter));
		assert.match(page, /Supporter subscriber, billed every year/);
		assert.match(page, /Manage your subscription/);
		const legacy = await addReader(m, user, "legacy@example.org", paidFields());
		assert.match(await visit(user, await signInReader(m, user, legacy)), /Paid subscriber, billed every month/);
		const quarterly = await addReader(m, user, "quarterly@example.org", paidFields({ paidInterval: "quarter" }));
		assert.match(await visit(user, await signInReader(m, user, quarterly)), /billed every 3 months/);
	});

	test("shows a lifetime reader, a comp and a gift apart, with no billing page to manage", async () => {
		const user = await tieredNewsletter();
		const life = await addReader(m, user, "life@example.org", { tier: "paid", paidTierId: "t_supporter", paidInterval: "lifetime", paidUntil: new Date("2099-12-31") });
		assert.match(await visit(user, await signInReader(m, user, life)), /Supporter subscriber, paid once for life/);

		const until = new Date(Date.now() + 40 * DAY_MS);
		const grant = (kind) => ({ tier: "paid", paidTierId: "t_supporter", paidUntil: new Date(until.getTime() - 3 * DAY_MS), grant: { kind, tierId: "t_supporter", until } });
		const comp = await visit(user, await signInReader(m, user, await addReader(m, user, "comp@example.org", grant("comp"))));
		assert.match(comp, /Supporter subscriber, complimentary access/);
		assert.match(comp, /Your access runs to /);
		assert.doesNotMatch(comp, /Manage your subscription|Become a paid subscriber/);
		const gift = await visit(user, await signInReader(m, user, await addReader(m, user, "gift@example.org", grant("gift"))));
		assert.match(gift, /Supporter subscriber, on a gift/);
	});

	test("shows a pledge, what it is for and that nothing is charged, with a way to cancel it", async () => {
		const user = await tieredNewsletter({ enabled: false, pledges: { enabled: true, noticeDays: 7 } });
		const pledger = await addReader(m, user, "pledger@example.org", { source: "pledge" });
		await m.Pledge.create({ accountId: user.accountId, newsletterId: user.newsletterId, email: "pledger@example.org", tierId: "t_supporter", option: "year", amountCents: 12000, currency: "usd", status: "active", stripeCustomerId: "cus_p" });
		const page = await visit(user, await signInReader(m, user, pledger));
		assert.match(page, /Free subscriber/);
		assert.match(page, /You pledged \$120\.00 a year for the Supporter tier/);
		assert.match(page, /Nothing is charged yet/);
		assert.match(page, new RegExp(`href="https://${user.slug}\\.${SHARED_DOMAIN}/pledge\\?token=[^"]+"[^>]*>Cancel your pledge`));
		assert.match(page, /See the plans/);
		assert.doesNotMatch(page, /Manage your subscription/, "a pledger has no billing page");

		await m.Pledge.updateOne({ accountId: user.accountId, email: "pledger@example.org" }, { $set: { status: "scheduled", chargeAt: new Date(Date.now() + 3 * DAY_MS) } });
		assert.match(await visit(user, await signInReader(m, user, pledger)), /your first charge is on /);
		await m.Pledge.updateOne({ accountId: user.accountId, email: "pledger@example.org" }, { $set: { status: "canceled" } });
		assert.doesNotMatch(await visit(user, await signInReader(m, user, pledger)), /You pledged/);
	});
});
