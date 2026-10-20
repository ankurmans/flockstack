import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { after, before, describe, test } from "node:test";
import { createElement } from "react";
import { prerenderToNodeStream } from "react-dom/static";
import { activate, as, callApi, catchRedirect, form, jsonRequest, listPlanPrices, mockStripe, signIn, startTestApp, withEnv } from "./helpers/app.mjs";
import { published } from "./stubs/qstash.mjs";
import { sent as sesEmails } from "./stubs/ses.mjs";

// The Free plan on FlockStack Cloud: what an account without a paid subscription has, how it is capped, what keeps it from
// being a spam magnet and what a paid plan lifts. Sends go through the real code with QStash and SES in memory.
let app;
let m;
let processed = 0;

const DAY_MS = 86_400_000;
const textOf = (markup) => markup.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

async function prerender(element) {
	const { prelude } = await prerenderToNodeStream(element);
	let html = "";
	for await (const chunk of prelude) html += chunk;
	return html.replaceAll("<!-- -->", "");
}

async function runJobs() {
	while (processed < published.length) {
		const { url, body } = published[processed++];
		if (url.endsWith("/api/jobs/send-batch")) await m.sendBatchRoute.POST(jsonRequest(url, { method: "POST", body }));
	}
}

// A signed-up account on the Free plan with a newsletter on the shared address and this many readers.
async function customer(email, { contacts = 0, welcome = false, paid = false } = {}) {
	const user = await signIn(email);
	if (paid) await activate(user);
	const slug = email.split("@")[0].replace(/[^a-z0-9]/g, "-");
	const url = await as(user, () =>
		catchRedirect(
			m.newsletters.saveNewsletter(
				null,
				form({
					name: `${slug} news`,
					slug,
					postalAddress: "1 Main St, Paris",
					archiveEnabled: "on",
					...(welcome && { welcomeEnabled: "on", welcomeSubject: "Welcome", welcomeMarkdown: "Thanks for joining." }),
				})
			)
		)
	);
	user.newsletterId = url.split("/").at(-1);
	user.slug = slug;
	user.account = await m.Account.findById(user.accountId).lean();
	await addContacts(user, contacts);
	return user;
}

async function addContacts(user, count, prefix = "reader") {
	if (count === 0) return;
	await m.Contact.insertMany(
		Array.from({ length: count }, (_, index) => ({
			accountId: user.accountId,
			newsletterId: user.newsletterId,
			email: `${prefix}${index}@${user.slug}.example.org`,
			status: "active",
			source: "import",
		}))
	);
}

async function draft(user, subject = "Issue") {
	const url = await as(user, () => catchRedirect(m.campaigns.createCampaign(user.newsletterId)));
	const id = url.split("/").at(-1);
	await as(user, () => m.campaigns.saveCampaign(id, { subject, previewText: "This week", body: "<p>Hello</p>" }));
	return id;
}

// A new draft, sent.
async function sendNew(user, subject) {
	const id = await draft(user, subject);
	return as(user, () => m.campaigns.sendCampaign(id, {}));
}

const load = (user) => m.Account.findById(user.accountId).lean();

// Campaigns the account sent before, settled and with their opens, which lift the cap on the first ones.
async function sendBefore(user, count, { sent = 100, opened = 30, complained = 0, bounced = 0, hoursAgo = 72 } = {}) {
	const at = new Date(Date.now() - hoursAgo * 3_600_000);
	for (let index = 0; index < count; index++) {
		await m.Campaign.create({
			accountId: user.accountId,
			newsletterId: user.newsletterId,
			subject: `Earlier ${index}`,
			status: "sent",
			stats: { recipients: sent, sent, opened, complained, bounced },
			startedAt: at,
			sentAt: at,
			finishedAt: at,
		});
	}
}

before(async () => {
	app = await startTestApp({ QSTASH_CURRENT_SIGNING_KEY: "sig-current", QSTASH_NEXT_SIGNING_KEY: "sig-next" });
	// Billing pages read the plans on sale from Stripe.
	mockStripe(({ method, path, query }) => (method === "GET" && path === "/v1/prices" ? listPlanPrices(query) : { status: 404, error: { type: "invalid_request_error", message: `No mock for ${method} ${path}` } }));
	m = {
		plans: await import("../lib/plans.js"),
		state: await import("../lib/account-state.js"),
		freePlan: await import("../lib/free-plan.js"),
		usage: await import("../lib/usage.js"),
		render: await import("../lib/render-email.js"),
		sendingRules: await import("../lib/sending-rules.js"),
		archiveData: await import("../lib/archive-data.js"),
		pricing: await import("../lib/pricing.js"),
		landing: await import("../lib/marketing/landing.js"),
		disposable: await import("../lib/disposable-domains.js"),
		config: await import("../lib/config.js"),
		newsletters: await import("../app/(app)/newsletters/actions.js"),
		campaigns: await import("../app/(app)/campaigns/actions.js"),
		apiKeys: await import("../app/(app)/api-keys/actions.js"),
		billingPage: await import("../app/(account)/billing/page.js"),
		accountPage: await import("../app/(account)/account/page.js"),
		sendBatchRoute: await import("../app/api/jobs/send-batch/route.js"),
		FooterArchive: (await import("../components/FooterArchive.jsx")).default,
		SliderPricing: (await import("../components/SliderPricing.jsx")).default,
		SectionPricing: (await import("../components/marketing/SectionPricing.jsx")).default,
		SectionCompare: (await import("../components/marketing/SectionCompare.jsx")).default,
		Account: (await import("../models/Account.js")).default,
		Campaign: (await import("../models/Campaign.js")).default,
		Contact: (await import("../models/Contact.js")).default,
		Message: (await import("../models/Message.js")).default,
		Automation: (await import("../models/Automation.js")).default,
		Newsletter: (await import("../models/Newsletter.js")).default,
	};
});

after(() => app?.stop());

describe("which plan an account is on", () => {
	test("no subscription, a canceled or lapsed one, and an unknown one are Free; a paid status keeps its plan", () => {
		const { getAccountPlan, isOnFreeTier } = m.plans;
		assert.equal(getAccountPlan({}).id, "free");
		assert.equal(getAccountPlan(null).id, "free");
		for (const status of ["canceled", "unpaid", "incomplete", "incomplete_expired", "paused"]) {
			assert.equal(getAccountPlan({ subscriptionStatus: status, plan: "scale" }).id, "free", `${status}: the last plan is remembered, not used`);
		}
		for (const status of ["active", "trialing", "past_due"]) assert.equal(getAccountPlan({ subscriptionStatus: status, plan: "pro" }).id, "pro", status);
		assert.equal(getAccountPlan({ subscriptionStatus: "active" }).id, "free", "a paid status with no known plan");
		assert.equal(isOnFreeTier({}), true);
		assert.equal(isOnFreeTier({ subscriptionStatus: "active", plan: "starter" }), false);
		const comp = { plan: "growth", grantedAt: new Date(Date.now() - DAY_MS), by: "admin@example.com" };
		assert.equal(getAccountPlan({ comp }).id, "growth", "a plan an admin gave");
		assert.equal(isOnFreeTier({ comp }), false);
		assert.equal(getAccountPlan({ comp: { ...comp, until: new Date(Date.now() - 1000) } }).id, "free", "and back to Free when it ends");
	});

	test("Free is not a plan on sale, and its numbers are in lib/plans.js", () => {
		const { FREE_PLAN, FREE_GUARDS, PLAN_IDS, PLANS } = m.plans;
		assert.equal(PLAN_IDS.includes("free"), false, "nothing sells it, and no Polar product exists for it");
		assert.equal(PLANS.some(({ id }) => id === "free"), false);
		assert.deepEqual(
			[FREE_PLAN.subscribers, FREE_PLAN.emailsPerMonth, FREE_PLAN.newsletters, FREE_PLAN.automations, FREE_PLAN.webhookEndpoints, FREE_PLAN.importPosts, FREE_PLAN.importImageBytes],
			[2_500, 10_000, 1, 2, 1, 100, 200 * 1024 ** 2]
		);
		assert.deepEqual(FREE_GUARDS.firstCampaigns, { count: 3, recipients: 500, minOpenRate: 0.01, settleHours: 24 });
		assert.deepEqual(m.plans.getAccountLimits({}), { emails: 10_000, subscribers: 2_500 });
		assert.equal(m.plans.getWebhookEndpointLimit({}), 1);
		assert.deepEqual(m.plans.getImportLimits({}), { posts: 100, imageBytes: 200 * 1024 ** 2 });
		assert.equal(m.plans.getAccountLimits({ limitOverrides: { subscribers: 9_000, emailsPerMonth: 50_000 } }).subscribers, 9_000, "an admin can give a free account more");
	});

	test("a self-hosted server has no plans, so nothing is Free there", () =>
		withEnv({ FLOCKSTACK_CLOUD: "" }, () => {
			assert.equal(m.plans.isOnFreeTier({}), false);
			assert.equal(m.plans.getAccountLimits({}), null);
			assert.equal(m.freePlan.showsSentWithLink({}), false);
		}));

	test("a new account's months run on from the day it started; a plan that ended starts them after its paid period", async () => {
		const fresh = await signIn("months-new@example.com");
		const account = await load(fresh);
		assert.ok(account.usage.anchor && account.usage.periodEnd, "the Free plan's first month is set at sign-up");
		assert.equal(account.usage.paidThrough, null);

		const paidEnd = new Date(Date.now() - 10 * DAY_MS);
		await m.Account.updateOne(
			{ _id: fresh.accountId },
			{ $set: { plan: "growth", subscriptionStatus: "canceled", usage: { emailsSent: 99_000, anchor: new Date(paidEnd.getTime() - 20 * DAY_MS), paidThrough: paidEnd, periodStart: new Date(paidEnd.getTime() - 20 * DAY_MS), periodEnd: paidEnd } } }
		);
		const lapsed = await m.usage.getUsage(await load(fresh));
		assert.deepEqual([lapsed.emailsSent, lapsed.emailsLimit, lapsed.subscribersLimit], [0, 10_000, 2_500], "a fresh Free month, not the paid month's 99,000");
		const stored = await load(fresh);
		assert.equal(stored.usage.paidThrough, null, "stored once");
		assert.equal(new Date(stored.usage.anchor).getTime(), paidEnd.getTime());
		assert.equal(m.freePlan.getLapsedPlan(stored).id, "growth");
		assert.equal(m.freePlan.getLapsedPlan({}), null);
	});
});

describe("the emails stop at the cap, with the numbers", () => {
	test("a send that would pass the month's 10,000 is refused up front, nothing is queued or cut, and there are no extra emails", async () => {
		const user = await customer("cap@example.com", { contacts: 3 });
		const id = await draft(user);
		await m.Account.updateOne({ _id: user.accountId }, { $set: { "usage.emailsSent": 9_998 } });

		const refused = await as(user, () => m.campaigns.sendCampaign(id, {}));
		assert.equal(refused.code, "plan_limit_emails");
		assert.equal(refused.error, "This send needs 3 emails and the Free plan has 2 left this month, of 10,000. Upgrade to send, or send to fewer people.");
		assert.equal(await m.Message.countDocuments({ accountId: user.accountId }), 0, "nothing queued");
		assert.equal((await m.Campaign.findOne({ accountId: user.accountId, _id: id }).lean()).status, "draft");
		assert.equal((await load(user)).usage.emailsSent, 9_998, "and nothing counted");

		await m.Account.updateOne({ _id: user.accountId }, { $set: { "usage.emailsSent": 9_997, polarSubscriptionId: "sub_x", extraEmails: { billable: true, limit: 1_000 } } });
		assert.equal(m.plans.canSendExtraEmails(await load(user)), false, "Free is never billed for extra emails");
		assert.deepEqual(await as(user, () => m.campaigns.sendCampaign(id, {})), { ok: true }, "exactly what is left fits");
		await runJobs();
		assert.equal((await load(user)).usage.emailsSent, 10_000);
	});

	test("a plan that lapsed keeps everything and falls back to Free's limits: over them, campaigns wait with a clear message", async () => {
		const user = await customer("lapsed@example.com", { contacts: 2_501 });
		await m.Account.updateOne({ _id: user.accountId }, { $set: { plan: "growth", subscriptionStatus: "canceled" } });
		await sendBefore(user, 3);
		const id = await draft(user);

		const refused = await as(user, () => m.campaigns.sendCampaign(id, {}));
		assert.equal(refused.code, "plan_limit_subscribers");
		assert.equal(
			refused.error,
			"You have 2,501 subscribers and the Free plan allows 2,500. Nothing is deleted, but campaigns can't go out until you upgrade or remove subscribers."
		);
		assert.equal(await m.Contact.countDocuments({ accountId: user.accountId, status: "active" }), 2_501, "all readable, none deleted");
		assert.ok(await m.Campaign.exists({ accountId: user.accountId, _id: id }));

		const usage = await m.usage.getUsage(await load(user));
		assert.deepEqual([usage.subscribers, usage.subscribersLimit, usage.emailsLimit], [2_501, 2_500, 10_000]);
		const banner = await prerender(createElement((await import("../components/BannerUsage.jsx")).default, { usage, lapsedPlan: m.plans.getPlan("growth") }));
		assert.match(textOf(banner), /Your Growth plan ended, so you're on Free\. Everything you made is kept\. You have 2,501 subscribers and your plan allows 2,500\./);

		await m.Contact.deleteOne({ accountId: user.accountId, email: `reader0@${user.slug}.example.org` });
		assert.equal((await as(user, () => m.campaigns.sendCampaign(id, {}))).ok, true, "under the limit it sends again");
	});
});

describe("the first campaigns of a Free account", () => {
	test("go to 500 people at most each: 501 is refused with the numbers, 500 goes", async () => {
		const over = await customer("start-over@example.com", { contacts: 501 });
		const id = await draft(over);
		const refused = await as(over, () => m.campaigns.sendCampaign(id, {}));
		assert.equal(refused.code, "plan_limit_emails");
		assert.match(refused.error, /goes to 500 people at most\. This one would go to 501\./);
		assert.match(refused.error, /The limit lifts once 3 campaigns have gone out and settled/);
		assert.equal(await m.Message.countDocuments({ accountId: over.accountId }), 0);

		const boundary = (total) => m.freePlan.getFirstCampaignsProblem({ account: {}, campaigns: [], total });
		assert.equal(boundary(500), null, "500 goes");
		assert.equal(boundary(501).code, "plan_limit_emails");
	});

	test("a send in steps counts what it already sent, so the steps can't get around the cap", () => {
		const free = { subscriptionStatus: undefined };
		const problem = (total) => m.freePlan.getFirstCampaignsProblem({ account: free, campaigns: [], total });
		assert.equal(problem(500), null);
		assert.match(problem(600).message, /500 people at most\. This one would go to 600\./, "400 sent, then 200 more");
		assert.equal(problem(600).code, "plan_limit_emails");
		assert.equal(m.freePlan.getFirstCampaignsProblem({ account: { subscriptionStatus: "active", plan: "starter" }, campaigns: [], total: 600 }), null);
	});

	test("lift after 3 settled campaigns with few complaints and some opens, and not before", async () => {
		const { hasProvenSending } = m.freePlan;
		const stats = (sent, opened, complained = 0, bounced = 0, hoursAgo = 72) => ({ stats: { sent, opened, complained, bounced }, finishedAt: new Date(Date.now() - hoursAgo * 3_600_000) });
		const good = [stats(100, 30), stats(100, 25), stats(100, 20)];
		assert.equal(hasProvenSending(good), true);
		assert.equal(hasProvenSending(good.slice(0, 2)), false, "two aren't enough");
		assert.equal(hasProvenSending([...good.slice(0, 2), stats(100, 20, 0, 0, 2)]), false, "the third hasn't settled for a day");
		assert.equal(hasProvenSending([stats(100, 0), stats(100, 0), stats(100, 0)]), false, "nobody opened");
		assert.equal(hasProvenSending([stats(100, 30, 1), stats(100, 25, 0), stats(100, 20, 0)]), true, "one complaint never counts");
		assert.equal(hasProvenSending([stats(100, 30, 3), stats(100, 25, 0), stats(100, 20, 0)]), false, "3 in 300 is over the Free watch level");
		assert.equal(hasProvenSending([stats(100, 30, 0, 5), stats(100, 25), stats(100, 20)]), false, "and so is 5 bounces in 300");

		const check = async (user, total = 501) =>
			m.freePlan.getFirstCampaignsProblem({ account: await load(user), campaigns: await m.Campaign.find({ accountId: user.accountId, status: "sent" }).lean(), total });
		const proven = await customer("start-proven@example.com");
		await sendBefore(proven, 3);
		assert.equal(await check(proven), null, "501 goes after 3 good campaigns");

		const complaining = await customer("start-complaints@example.com");
		await sendBefore(complaining, 3, { sent: 100, complained: 3 });
		assert.equal((await check(complaining)).code, "plan_limit_emails");

		const unopened = await customer("start-unopened@example.com");
		await sendBefore(unopened, 3, { opened: 0 });
		assert.equal((await check(unopened)).code, "plan_limit_emails");

		const fresh = await customer("start-fresh@example.com");
		await sendBefore(fresh, 3, { hoursAgo: 2 });
		assert.equal((await check(fresh)).code, "plan_limit_emails", "they haven't settled for a day");
	});

	test("an admin's bigger limits trust the account, and a paid plan has no cap", async () => {
		const total = 2_000;
		const free = { subscriptionStatus: undefined };
		assert.equal(m.freePlan.getFirstCampaignsProblem({ account: free, campaigns: [], total }).code, "plan_limit_emails");
		assert.equal(m.freePlan.getFirstCampaignsProblem({ account: { ...free, limitOverrides: { subscribers: 5_000 } }, campaigns: [], total }), null, "an admin raised its subscribers");
		assert.equal(m.freePlan.getFirstCampaignsProblem({ account: { ...free, limitOverrides: { emailsPerMonth: 50_000 } }, campaigns: [], total }), null, "or its emails");
		assert.equal(m.freePlan.getFirstCampaignsProblem({ account: { subscriptionStatus: "active", plan: "starter" }, campaigns: [], total }), null, "a paid plan has no cap");
	});

	test("the first send still goes through the first-send slice: never-mailed contacts past the slice wait for its check", async () => {
		const user = await customer("start-slice@example.com", { contacts: 400 });
		const id = await draft(user);
		assert.equal((await as(user, () => m.campaigns.sendCampaign(id, {}))).ok, true);
		const campaign = await m.Campaign.findOne({ accountId: user.accountId, _id: id }).lean();
		assert.deepEqual([campaign.firstSend.slice, campaign.firstSend.held], [200, 200], "200 first, 200 held back for the check three hours later");
		assert.equal(await m.Message.countDocuments({ accountId: user.accountId, campaignId: id, status: "held" }), 200);
		await runJobs();
	});
});

describe("tighter levels for Free", () => {
	test("the levels come from FREE_LIMITS for a free account and LIMITS for a paid one", async () => {
		const levels = await import("../lib/rate-levels.js");
		assert.equal(levels.getRateLimits({}), m.config.FREE_LIMITS);
		assert.equal(levels.getRateLimits({ subscriptionStatus: "active", plan: "starter" }), m.config.LIMITS);
		const counts = { sent: 5_000, bounced: 0, complained: 2 };
		assert.equal(levels.judgeRates(counts, m.config.FREE_LIMITS)?.level, "pause", "2 in 5,000 is 0.04%");
		assert.equal(levels.judgeRates(counts, m.config.LIMITS), null, "and nothing on a paid plan, whose pause level is 0.08%");
		assert.equal(levels.judgeRates({ sent: 1_000, bounced: 41, complained: 0 }, m.config.FREE_LIMITS)?.level, "block", "over 4% bounces blocks on Free");
		assert.equal(levels.judgeRates({ sent: 1_000, bounced: 41, complained: 0 }, m.config.LIMITS)?.level, "pause", "and only pauses on a paid plan, which blocks at 5%");
		assert.ok(m.config.FREE_WATCH.complaintRate <= m.config.WATCH.complaintRate && m.config.FREE_WATCH.bounceRate <= m.config.WATCH.bounceRate);
	});

	test("a free account's campaign pauses on its own rates, where a paid account's would carry on", async () => {
		const rules = m.sendingRules;
		const stats = { sent: 3_000, bounced: 0, complained: 2 };
		assert.equal(rules.getCampaignRateProblem(stats, {}, m.config.FREE_LIMITS)?.level, "pause");
		assert.match(rules.getCampaignRateProblem(stats, {}, m.config.FREE_LIMITS).reason, /at 0\.20% with 3 complaints, the account is blocked/);
		assert.equal(rules.getCampaignRateProblem(stats, {}, m.config.LIMITS), null);
	});
});

describe("the Sent with FlockStack link", () => {
	const campaign = { format: "markdown", markdown: "Hello", subject: "Hi", previewText: "" };
	const newsletter = { _id: "6650f1c2e9b1d4a012345678", name: "Notes", slug: "notes", fromEmail: "hello@notes.example.org", postalAddress: "1 Main St" };
	const contact = { _id: "6650f1c2e9b1d4a0123456aa", email: "reader@example.org" };

	test("is under the footer of the email's HTML and text when asked for, and nowhere else", () => {
		const free = m.sendingRules.buildRecipientEmail({ campaign, newsletter, contact, sentWith: true });
		assert.match(free.html, /<a href="https:\/\/flockstack\.io\/\?ref=newsletter-footer" data-sent-with[^>]*>Sent with FlockStack<\/a>/);
		assert.match(free.text, /Sent with FlockStack: https:\/\/flockstack\.io\/\?ref=newsletter-footer/);
		assert.ok(free.html.indexOf("Unsubscribe") < free.html.indexOf("Sent with FlockStack"), "under the footer");

		const paid = m.sendingRules.buildRecipientEmail({ campaign, newsletter, contact });
		assert.doesNotMatch(paid.html + paid.text, /Sent with FlockStack/);
		const order = m.sendingRules.buildRecipientEmail({ campaign, newsletter, contact, transactionalReason: "You bought it.", sentWith: true });
		assert.doesNotMatch(order.html, /Sent with FlockStack/, "an order's email isn't the newsletter's");
	});

	test("stays on an HTML issue that brings its own unsubscribe link", () => {
		const html = '<html><body><p>Mine</p><a href="{{unsubscribe_url}}">Leave</a></body></html>';
		const rendered = m.render.renderEmail({ format: "html", html, subject: "Hi", newsletter, sentWith: true });
		assert.match(rendered.html, /Sent with FlockStack<\/a>[\s\S]*<\/body>/);
		assert.equal(m.render.renderEmail({ format: "html", html, subject: "Hi", newsletter }).html.includes("Sent with FlockStack"), false);
	});

	test("its link is not a tracked click", async () => {
		const { addTracking } = await import("../lib/tracking.js");
		const tracked = addTracking('<a href="https://flockstack.io/?ref=newsletter-footer">x</a><a href="https://example.org/a">y</a>', { baseUrl: "https://notes.example.org", messageId: "6650f1c2e9b1d4a0123456bb" });
		assert.match(tracked, /href="https:\/\/flockstack\.io\/\?ref=newsletter-footer"/);
		assert.match(tracked, /\/c\//);
	});

	test("a Free account's sent emails carry it, a paid account's don't, and a paid account can turn it on", async () => {
		const free = await customer("link-free@example.com", { contacts: 2, welcome: true });
		const before = sesEmails.length;
		assert.deepEqual(await sendNew(free), { ok: true });
		await runJobs();
		const freeMails = sesEmails.slice(before).filter(({ to }) => to.endsWith(`@${free.slug}.example.org`));
		assert.equal(freeMails.length, 2);
		for (const mail of freeMails) assert.match(mail.html, /Sent with FlockStack/);

		const paid = await customer("link-paid@example.com", { contacts: 2, paid: true });
		const paidBefore = sesEmails.length;
		assert.equal((await sendNew(paid)).ok, true);
		await runJobs();
		const paidMails = sesEmails.slice(paidBefore).filter(({ to }) => to.endsWith(`@${paid.slug}.example.org`));
		assert.equal(paidMails.length, 2);
		for (const mail of paidMails) assert.doesNotMatch(mail.html, /Sent with FlockStack/);

		const { key } = await as(paid, () => m.apiKeys.createApiKey(null, form({ name: "Agent" })));
		const on = await callApi("POST", "/api/v1/billing/sent-with-link", { key, body: { enabled: true } });
		assert.deepEqual([on.status, on.body], [200, { enabled: true }]);
		assert.equal((await callApi("GET", "/api/v1/billing", { key })).body.sentWithLink.shown, true);
		const againBefore = sesEmails.length;
		assert.equal((await sendNew(paid, "Second")).ok, true);
		await runJobs();
		for (const mail of sesEmails.slice(againBefore).filter(({ to }) => to.endsWith(`@${paid.slug}.example.org`))) assert.match(mail.html, /Sent with FlockStack/);
	});

	test("the Free plan can't turn it off, and says so", async () => {
		const free = await customer("link-required@example.com");
		const { key } = await as(free, () => m.apiKeys.createApiKey(null, form({ name: "Agent" })));
		const off = await callApi("POST", "/api/v1/billing/sent-with-link", { key, body: { enabled: false } });
		assert.equal(off.status, 409);
		assert.match(off.body.error.message, /The Free plan always carries the Sent with FlockStack link/);
		const billing = await callApi("GET", "/api/v1/billing", { key });
		assert.deepEqual(billing.body.sentWithLink, { shown: true, required: true });
		assert.equal((await load(free)).sentWithLink, undefined);
	});

	test("is in the footer of a Free account's website and not a paid account's", async () => {
		const free = await customer("link-site-free@example.com");
		const paid = await customer("link-site-paid@example.com", { paid: true });
		for (const user of [free, paid]) await m.Campaign.create({ accountId: user.accountId, newsletterId: user.newsletterId, subject: "Issue", status: "sent", sentAt: new Date(), archiveSlug: `issue-${user.slug}` });

		const freeSite = await m.archiveData.getArchiveNewsletter(free.slug);
		const paidSite = await m.archiveData.getArchiveNewsletter(paid.slug);
		assert.equal(freeSite.sentWith, true);
		assert.equal(paidSite.sentWith, false);
		const footer = (newsletter) => prerender(createElement(m.FooterArchive, { newsletter, indexHref: "/", feedHref: "/feed.xml" }));
		const freeMarkup = await footer(freeSite);
		assert.match(freeMarkup, /<a href="https:\/\/flockstack\.io\/\?ref=newsletter-footer" data-sent-with[^>]*>Sent with FlockStack<\/a>/);
		assert.doesNotMatch(await footer(paidSite), /Sent with FlockStack/);

		await m.Account.updateOne({ _id: paid.accountId }, { $set: { sentWithLink: true } });
	});
});

describe("limits that depend on the plan", () => {
	test("one newsletter: the second is refused with the Free plan's message, a paid plan has up to 3", async () => {
		const free = await customer("one-newsletter@example.com");
		const second = await as(free, () => m.newsletters.saveNewsletter(null, form({ name: "Second", slug: "second-free", postalAddress: "1 Main St, Paris" })));
		assert.deepEqual(second, { error: "The Free plan has 1 newsletter. Upgrade for up to 3" });
		assert.equal(await m.Newsletter.countDocuments({ accountId: free.accountId }), 1);

		const { key } = await as(free, () => m.apiKeys.createApiKey(null, form({ name: "Agent" })));
		const viaApi = await callApi("POST", "/api/v1/newsletters", { key, body: { name: "Second" } });
		assert.equal(viaApi.status, 409);
		assert.equal(viaApi.body.error.message, "The Free plan has 1 newsletter. Upgrade for up to 3");

		await activate(free);
		assert.equal((await callApi("POST", "/api/v1/newsletters", { key, body: { name: "Second" } })).status, 201, "a paid plan lifts it");
	});

	test("one webhook endpoint and two automations, and the limits follow a lapsed plan down", async () => {
		const user = await customer("small-limits@example.com");
		const { key } = await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Agent" })));
		const hook = (url) => callApi("POST", "/api/v1/webhooks", { key, body: { url, events: ["subscriber.created"] } });
		assert.equal((await hook("https://example.com/one")).status, 201);
		const second = await hook("https://example.com/two");
		assert.equal(second.status, 409);
		assert.match(second.body.error.message, /Your plan has up to 1 webhook endpoints/);

		const automation = (name) =>
			callApi("POST", "/api/v1/automations", {
				key,
				body: { newsletter: user.slug, name, trigger: { type: "subscribed" }, steps: [{ type: "email", subject: name, content: "Hi" }] },
			});
		assert.equal((await automation("One")).status, 201);
		assert.equal((await automation("Two")).status, 201);
		const third = await automation("Three");
		assert.equal(third.status, 409, JSON.stringify(third.body));
		assert.match(third.body.error.message, /The Free plan has up to 2 automations, besides the welcome email/);

		await activate(user);
		assert.equal((await hook("https://example.com/two")).status, 201, "a paid plan has more endpoints");
		assert.equal((await automation("Three")).status, 201, "and as many automations as it likes");

		await m.Account.updateOne({ _id: user.accountId }, { $set: { subscriptionStatus: "canceled" } });
		assert.equal(await m.Automation.countDocuments({ accountId: user.accountId, status: { $ne: "deleted" } }), 3, "a lapsed plan keeps what it made");
		assert.equal((await automation("Four")).status, 409);
	});

	test("posts to import and the pictures that come with them are capped at Free's 100 and 200 MB", () => {
		assert.deepEqual(m.plans.getImportLimits({}), { posts: 100, imageBytes: 209_715_200 });
		assert.deepEqual(m.plans.getImportLimits({ subscriptionStatus: "active", plan: "starter" }), { posts: 500, imageBytes: 1024 ** 3 });
	});

	test("no dedicated IP: it is for Pro and above", async () => {
		const { canHaveDedicatedIp } = await import("../lib/dedicated-ip.js");
		assert.equal(canHaveDedicatedIp({}), false);
		assert.equal(canHaveDedicatedIp({ subscriptionStatus: "active", plan: "pro" }), true);
	});
});

describe("sign-up", () => {
	test("the list of throwaway domains is bundled: 200 or more, with subdomains and look-alikes told apart", () => {
		const { DISPOSABLE_DOMAINS, isDisposableDomain } = m.disposable;
		assert.ok(DISPOSABLE_DOMAINS.size >= 200, `${DISPOSABLE_DOMAINS.size} domains`);
		for (const domain of ["mailinator.com", "guerrillamail.com", "yopmail.com", "10minutemail.com", "temp-mail.org", "sharklasers.com", "1secmail.com", "trashmail.com"]) {
			assert.equal(isDisposableDomain(domain), true, domain);
		}
		assert.equal(isDisposableDomain("eu.mailinator.com"), true, "a subdomain of a listed domain");
		for (const domain of ["gmail.com", "outlook.com", "proton.me", "example.com", "notmailinator.com", "mailinator.com.example.org"]) assert.equal(isDisposableDomain(domain), false, domain);
		for (const domain of DISPOSABLE_DOMAINS) assert.match(domain, /^[a-z0-9-]+(\.[a-z0-9-]+)+$/, domain);
	});

	test("the sign-in form sends no code to a throwaway inbox, and every limit sits in lib/plans.js", async () => {
		const signin = await import("../app/signin/actions.js");
		const auth = await import("../lib/auth.js");
		const refused = await as({ jar: new Map(), ip: "198.51.100.77" }, () => signin.sendSigninCode(null, form({ email: "burner@guerrillamail.com" })));
		assert.deepEqual(refused, { error: auth.SIGNUP_ERRORS.email_disposable });
		assert.deepEqual([m.plans.FREE_GUARDS.signupsPerIpPerDay, m.plans.FREE_GUARDS.signupsPerDay], [3, 1_000]);
		assert.match(auth.SIGNUP_ERRORS.signup_busy, /isn't opening new accounts for the rest of today/);
	});

	test("a day's accounts are capped for a region as a whole, and a person with an account still signs in", async () => {
		const RateLimit = (await import("../models/RateLimit.js")).default;
		const { platformEmails } = await import("./helpers/app.mjs");
		const size = DAY_MS;
		const index = Math.floor(Date.now() / size);
		const key = `signup-day:all:${index}`;
		await RateLimit.updateOne({ key }, { $set: { count: m.plans.FREE_GUARDS.signupsPerDay, expiresAt: new Date((index + 2) * size) } }, { upsert: true });
		try {
			const signin = await import("../app/signin/actions.js");
			const auth = await import("../lib/auth.js");
			const person = { email: "latecomer@example.com", jar: new Map(), ip: "198.51.100.88" };
			const sent = await as(person, () => signin.sendSigninCode(null, form({ email: person.email })));
			assert.equal(sent.email, person.email);
			const code = platformEmails.findLast(({ to }) => to.includes(person.email)).subject.slice(0, 6);
			const result = await as(person, () => signin.verifySigninCode(null, form({ email: person.email, code, next: "/" })));
			assert.deepEqual(result, { email: person.email, error: auth.SIGNUP_ERRORS.signup_busy });
			assert.equal(await m.Account.countDocuments({ ownerId: { $exists: true }, createdAt: { $gte: new Date(Date.now() - 1000) } }) >= 0, true);
		} finally {
			await RateLimit.deleteOne({ key });
		}
	});
});

describe("what the pages say", () => {
	test("the billing page shows Free as the current plan with its meters and an Upgrade button", async () => {
		const user = await customer("page-free@example.com", { contacts: 3 });
		const markup = await as(user, async () => prerender(await m.billingPage.default({ searchParams: Promise.resolve({}) })));
		const text = textOf(markup);
		assert.match(text, /Free/);
		assert.match(text, /2,500 subscribers · 10,000 emails a month · No card needed/);
		assert.match(text, /Emails this month.*0 of 10,000/);
		assert.match(text, /Subscribers.*3 of 2,500/);
		assert.match(text, /You're on Free\. Upgrade for more subscribers and emails/);
		assert.match(markup, /href="\/billing\/checkout\?plan=starter&(amp;)?interval=month"[^>]*>Upgrade/, "Upgrade leads to the same checkout as a first purchase");
		assert.doesNotMatch(text, /Pick a plan|start your trial|No plan\b|Sent with FlockStack Show/i);
		assert.doesNotMatch(markup, /name="sent-with-link"|id="sent-with-link"/, "the switch is for paid plans");
	});

	test("a paid account sees its plan, the link's switch and a way back to Free", async () => {
		const user = await customer("page-paid@example.com", { paid: true });
		const markup = await as(user, async () => prerender(await m.billingPage.default({ searchParams: Promise.resolve({}) })));
		const text = textOf(markup);
		assert.match(text, /Starter/);
		assert.match(text, /Change plan/);
		assert.match(markup, /id="sent-with-link"/);
		assert.match(text, /Show “Sent with FlockStack”|Show "Sent with FlockStack"/);
	});

	test("a lapsed account is told its plan ended, that it is on Free and that everything is kept", async () => {
		const user = await customer("page-lapsed@example.com", { contacts: 2_600 });
		await m.Account.updateOne({ _id: user.accountId }, { $set: { plan: "pro", subscriptionStatus: "canceled", interval: "month" } });
		const markup = await as(user, async () => prerender(await m.billingPage.default({ searchParams: Promise.resolve({}) })));
		const text = textOf(markup);
		assert.match(text, /Your Pro plan ended, so you're on Free\. Your newsletter, contacts and campaigns are kept: upgrade to get your Pro limits back\./);
		assert.match(text, /You have 2,600 subscribers and your plan allows 2,500\. Campaigns can't go out until you upgrade or get under it, and nothing is deleted\./);
		assert.match(text, /Subscribers.*2,600 of 2,500/);
	});

	test("the plans slider starts at Free, a $0 step before Starter, with Custom last", async () => {
		const pricing = m.pricing.getPricing(undefined, m.plans.PLANS);
		assert.equal(pricing.initialIndex, 0);
		assert.equal(pricing.free.id, "free");
		assert.equal(pricing.free.prices.month.price, "$0");
		assert.equal(pricing.plans.length, 5, "the five paid plans stay five");
		const html = await prerender(createElement(m.SliderPricing, { ...pricing, ctaHref: "/signin", ctaLabel: "Create your account" }));
		const labels = [...html.matchAll(/aria-label="([^"]*emails a month)"/g)].map(([, label]) => label);
		assert.equal(labels[0], "10,000 emails a month");
		assert.equal(labels[1], "25,000 emails a month");
		assert.match(labels.at(-1), /^Custom plan/);
		const text = textOf(html);
		assert.match(text, /\$0 \/month No card needed/);
		assert.match(text, /The Free plan has/);
		assert.match(text, /Start for free/);
		assert.doesNotMatch(text, /per 1,000 emails/, "Free has no extra emails to price");
		assert.match(html, /href="\/signin"[^>]*>Start for free/);

		const onPaid = await prerender(createElement(m.SliderPricing, { ...pricing, current: { plan: "pro", interval: "month" }, action: async () => {} }));
		assert.match(onPaid, /name="plan" value="free"/, "on a paid plan, Free is a step that goes back to it");
		assert.match(textOf(onPaid), /Downgrade to Free/);
		const onFree = await prerender(createElement(m.SliderPricing, { ...pricing, current: { plan: "free" } }));
		assert.match(textOf(onFree), /Current plan/);
		assert.doesNotMatch(onFree, /Start for free/);
	});

	test("(landing page test removed)", async () => {
		const pricing = textOf(await prerender(await m.SectionPricing()));
		assert.match(pricing, /(headline removed)/);
		assert.match(pricing, /Start for free/);
		assert.doesNotMatch(pricing, /Pick a plan|start your trial/i);

		const compare = textOf(await prerender(await m.SectionCompare()));
		assert.match(compare, /(comparison removed)/);
		assert.match(compare, /(comparison removed)/);
		const free = m.landing.getFreeComparison();
		assert.deepEqual(free.beehiiv, { subscribers: 2_500, automations: 0 }, "only what (comparison removed)");
		const faq = m.landing.FAQ.find(({ question }) => question === "Is there a free plan?").answer.join(" ");
		assert.match(faq, /2,500 subscribers, 10,000 emails a month/);
		assert.match(faq, /(comparison removed)/);
		assert.match(faq, /(comparison removed)/);
	});

	test("no page claims a plan has to be picked before using FlockStack", async () => {
		const roots = ["app", "components"];
		const files = [];
		for (const root of roots) {
			for (const entry of await readdir(new URL(`../${root}/`, import.meta.url), { recursive: true })) {
				if (/\.(jsx?|mjs)$/.test(entry) && !entry.startsWith("admin/")) files.push(`${root}/${entry}`);
			}
		}
		const offenders = [];
		for (const file of files) {
			const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
			if (/Pick a plan|pick a plan|Start your trial|start your trial|No plan\b/.test(source.replace(/trialDays[^\n]*/g, ""))) offenders.push(file);
		}
		assert.deepEqual(offenders, []);
	});
});
