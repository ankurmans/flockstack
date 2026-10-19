import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { activate, as, callApi, catchRedirect, form, jsonRequest, mockPolar, platformEmails, signIn, startTestApp, withEnv } from "./helpers/app.mjs";
import { flushAfter } from "./stubs/next-server.mjs";
import { published } from "./stubs/qstash.mjs";

// Extra emails past a paid Polar plan's: sends go on up to the owner's limit, each batch's extra emails are counted
// per month and reported to a stubbed Polar, which skips an event id it already has, like Polar does. Accounts get
// tiny allowances (an admin's emailsPerMonth) so each case sends a handful of emails.
let app;
let m;
let processed = 0;
let polar;

function polarApi({ method, path, body }) {
	polar.calls.push({ method, path, body });
	if (method === "POST" && path === "/v1/events/ingest") {
		if (polar.state === "down") return { status: 503, error: "Polar is down" };
		let inserted = 0;
		let duplicates = 0;
		for (const event of body.events) {
			if (polar.events.has(event.external_id)) duplicates++;
			else {
				polar.events.set(event.external_id, event);
				inserted++;
			}
		}
		// Polar took the events but the answer was lost on the way back.
		if (polar.state === "lost") return { status: 504, error: "Gateway timeout" };
		return { inserted, duplicates };
	}
	if (method === "GET" && path === "/v1/products/") return { items: [], pagination: { total_count: 0, max_page: 1 } };
	return { status: 404, error: `No mock for ${method} ${path}` };
}

// What Polar would bill: the sum of the counts of the events it kept.
function billedAtPolar(user) {
	return [...polar.events.values()].filter(({ external_customer_id: id }) => id === String(user.accountId)).reduce((sum, { metadata }) => sum + metadata.count, 0);
}

async function runJobs() {
	const results = [];
	while (processed < published.length) {
		const { url, body } = published[processed++];
		const route = url.endsWith("/api/jobs/send-batch") ? m.sendBatchRoute : m.scheduledRoute;
		const response = await route.POST(jsonRequest(url, { method: "POST", body }));
		results.push(await response.json());
	}
	return results;
}

// A paid Polar plan whose subscription carries the extra emails price, with room for `emails` a month.
async function setup(email, { emails, contacts, limit, billable = true, welcome = false, ...set }) {
	const user = await signIn(email);
	await activate(user, {
		limitOverrides: { emailsPerMonth: emails },
		polarCustomerId: `polar_cus_${email}`,
		polarSubscriptionId: `polar_sub_${email}`,
		extraEmails: { billable, ...(limit !== undefined && { limit }) },
		...set,
	});
	const slug = email.split("@")[0].replace(/[^a-z0-9]/g, "-");
	const url = await as(user, () =>
		catchRedirect(
			m.newsletters.saveNewsletter(
				null,
				form({
					name: `${slug} news`,
					slug,
					fromEmail: `hello@${slug}.flockstackmail.com`,
					postalAddress: "1 Main St, Paris",
					archiveEnabled: "on",
					...(welcome && { welcomeEnabled: "on", welcomeSubject: "Welcome", welcomeMarkdown: "Thanks for joining." }),
				})
			)
		)
	);
	user.newsletterId = url.split("/").at(-1);
	user.slug = slug;
	const rows = Array.from({ length: contacts }, (_, index) => ({ email: `reader${index}@${slug}.example.org`, status: "active" }));
	if (rows.length) await as(user, () => m.contacts.importContacts({ newsletterId: user.newsletterId, consent: true, rows }));
	return user;
}

// beforeJobs: runs between the send and its batches.
async function sendIssue(user, beforeJobs) {
	const id = await draftId(user);
	const result = await as(user, () => m.campaigns.sendCampaign(id, {}));
	await beforeJobs?.();
	await runJobs();
	return { id, result, campaign: await m.Campaign.findOne({ accountId: user.accountId, _id: id }).lean() };
}

async function extra(user) {
	const account = await m.Account.findById(user.accountId).lean();
	return m.ExtraEmailUsage.findOne({ accountId: user.accountId, periodStart: account.usage.periodStart }).lean();
}

const emailsTo = (user, prefix) => platformEmails.filter(({ to, subject }) => [to].flat().includes(user.email) && subject.startsWith(`[FlockStack] ${prefix}`));

before(async () => {
	app = await startTestApp({ POLAR_ACCESS_TOKEN: "polar_oat_test", QSTASH_CURRENT_SIGNING_KEY: "sig-current", QSTASH_NEXT_SIGNING_KEY: "sig-next" });
	m = {
		newsletters: await import("../app/(app)/newsletters/actions.js"),
		campaigns: await import("../app/(app)/campaigns/actions.js"),
		contacts: await import("../app/(app)/contacts/actions.js"),
		apiKeys: await import("../app/(app)/api-keys/actions.js"),
		billingActions: await import("../app/(account)/billing/actions.js"),
		admin: await import("../app/admin/actions.js"),
		sendBatchRoute: await import("../app/api/jobs/send-batch/route.js"),
		scheduledRoute: await import("../app/api/jobs/send-scheduled/route.js"),
		extraEmails: await import("../lib/extra-emails.js"),
		usage: await import("../lib/usage.js"),
		plans: await import("../lib/plans.js"),
		state: await import("../lib/account-state.js"),
		Account: (await import("../models/Account.js")).default,
		Campaign: (await import("../models/Campaign.js")).default,
		ExtraEmailUsage: (await import("../models/ExtraEmailUsage.js")).default,
	};
});

// Each test's reports only: what earlier tests left for the hourly job is taken off its list.
beforeEach(async () => {
	polar = { calls: [], events: new Map(), state: "up" };
	mockPolar(polarApi);
	await m.ExtraEmailUsage.updateMany({ due: true }, { $unset: { due: 1 } }).setOptions({ crossAccount: true });
});

after(() => app?.stop());

describe("the price", () => {
	test("$0.15 per 1,000 extra emails, 0.015 cents an email at Polar, up to the plan's emails by default and 10 times at most", () => {
		const { EXTRA_EMAILS, getExtraEmailsCost, getExtraEmailsLimit, getMaxExtraEmailsLimit } = m.plans;
		assert.equal(EXTRA_EMAILS.pricePerThousand, 0.15);
		assert.equal(Number(EXTRA_EMAILS.unitAmountCents) * 1000, 15, "15 cents per 1,000");
		assert.deepEqual([getExtraEmailsCost(1), getExtraEmailsCost(25_000), getExtraEmailsCost(1_000_000)], [0, 3.75, 150]);
		const pro = { plan: "pro", subscriptionStatus: "active", polarSubscriptionId: "sub", extraEmails: { billable: true } };
		assert.equal(getExtraEmailsLimit(pro), 250_000, "the plan's emails again: twice the plan at most");
		assert.equal(getExtraEmailsLimit({ ...pro, extraEmails: { billable: true, limit: 10_000 } }), 10_000);
		assert.equal(getExtraEmailsLimit({ ...pro, extraEmails: { billable: true, limit: 0 } }), 0);
		assert.equal(getMaxExtraEmailsLimit(pro), 2_500_000);
		assert.equal(getExtraEmailsLimit({ ...pro, extraEmails: { billable: true, limit: 9_000_000 } }), 2_500_000, "never past 10 times");
	});

	test("only a paid Polar plan whose subscription has the price can send extra emails", async () => {
		const { getExtraEmailsLimit } = m.plans;
		const pro = { plan: "pro", subscriptionStatus: "active", polarSubscriptionId: "sub", extraEmails: { billable: true } };
		assert.equal(getExtraEmailsLimit({ ...pro, extraEmails: { billable: false } }), 0, "a product bought before the price");
		assert.equal(getExtraEmailsLimit({ ...pro, subscriptionStatus: "past_due" }), 0, "not on a failing card");
		assert.equal(getExtraEmailsLimit({ ...pro, polarSubscriptionId: undefined }), 0, "Stripe bills it");
		const free = { comp: { plan: "max", grantedAt: new Date(Date.now() - 1000) }, extraEmails: { billable: true } };
		assert.equal(getExtraEmailsLimit(free), 0, "a free plan from an admin");
		assert.equal(await withEnv({ POLAR_ACCESS_TOKEN: "" }, () => getExtraEmailsLimit(pro)), 0, "no Polar on this server");
		assert.equal(await withEnv({ FLOCKSTACK_CLOUD: "" }, () => getExtraEmailsLimit(pro)), 0, "self-hosted: no billing, and no limits anyway");
		assert.equal(await withEnv({ FLOCKSTACK_CLOUD: "" }, () => m.state.getPlanLimitProblem({ account: pro, emailsSent: 9e9, recipients: 9e9, activeContacts: 9e9 })), null);
	});
});

describe("sending past the plan's emails", () => {
	test("a send across the plan's emails goes out whole: the ones past it are extra, counted once and reported to Polar", async () => {
		const user = await setup("boundary@example.com", { emails: 2, contacts: 3, limit: 10 });
		const { campaign } = await sendIssue(user);
		assert.equal(campaign.status, "sent");
		assert.equal(campaign.stats.sent, 3);
		const account = await m.Account.findById(user.accountId).lean();
		assert.equal(account.usage.emailsSent, 3);
		const usage = await extra(user);
		assert.deepEqual([usage.counted, usage.reported, usage.due, usage.pending?.to], [1, 1, undefined, undefined]);
		assert.equal(billedAtPolar(user), 1);
		const [event] = polar.events.values();
		assert.equal(event.name, "flockstack_extra_emails");
		assert.equal(event.external_id, `fs_extra_${user.accountId}_${account.usage.periodStart.getTime()}_0_1`);

		const second = await sendIssue(user);
		assert.equal(second.campaign.stats.sent, 3, "the next issue is all extra");
		assert.equal((await extra(user)).counted, 4);
		assert.equal(billedAtPolar(user), 1, "reported at most every 5 minutes from the send path");
		assert.deepEqual(await m.extraEmails.reportDueExtraEmails(), { reported: 3, failed: 0 }, "the hourly job sends the rest");
		assert.equal(billedAtPolar(user), 4);
		assert.deepEqual(await m.extraEmails.reportDueExtraEmails(), { reported: 0, failed: 0 });
		assert.equal((await extra(user)).due, undefined, "off the job's list");
	});

	test("the API and the billing data say how many extra emails went out and what they cost so far", async () => {
		const user = await setup("billing-data@example.com", { emails: 2, contacts: 4 });
		await sendIssue(user);
		const key = (await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Agent" })))).key;
		const billing = await callApi("GET", "/api/v1/billing", { key });
		assert.equal(billing.status, 200, JSON.stringify(billing.body));
		assert.deepEqual(billing.body.extraEmails, { available: true, pricePerThousand: 0.15, sent: 2, limit: 2, maxLimit: 20, estimatedCost: 0 });
		assert.deepEqual(
			[billing.body.usage.emailsSent, billing.body.usage.emailsLimit, billing.body.usage.extraEmailsSent, billing.body.usage.extraEmailsLimit, billing.body.usage.emailsLeft],
			[4, 2, 2, 2, 0]
		);
	});
});

describe("the owner's limit", () => {
	test("a send past the limit is refused before it starts, like a plan limit", async () => {
		const user = await setup("limit-refused@example.com", { emails: 2, contacts: 7, limit: 4 });
		const { result, campaign } = await sendIssue(user);
		assert.deepEqual(result, {
			code: "plan_limit_emails",
			error: "This send needs 7 emails and your plan has 6 left this month, extra emails included. Raise your extra emails limit or upgrade to send.",
		});
		assert.equal(campaign.status, "draft");
	});

	test("sending stops at the limit mid-send: the rest waits, and the owner hears at 80% and at 100%, once each", async () => {
		const user = await setup("limit@example.com", { emails: 2, contacts: 6, limit: 4 });
		// A confirmation email goes out between the check and the batch: it takes room too.
		const { campaign } = await sendIssue(user, () => m.Account.updateOne({ _id: user.accountId }, { $inc: { "usage.emailsSent": 1 } }));
		assert.equal(campaign.stats.sent, 5);
		assert.equal(campaign.status, "paused");
		assert.equal(campaign.pauseCode, "plan_limit_emails");
		assert.equal((await extra(user)).counted, 4);
		assert.equal(billedAtPolar(user), 4, "never more than the limit");
		assert.equal(emailsTo(user, "You've reached your extra emails limit").length, 1);
		assert.equal(emailsTo(user, "You've used 80%").length, 0, "straight to the limit: one email");

		const warned = await setup("warned@example.com", { emails: 1, contacts: 5, limit: 5 });
		await sendIssue(warned);
		assert.equal((await extra(warned)).counted, 4);
		assert.equal(emailsTo(warned, "You've used 80% of your extra emails limit").length, 1);
		assert.equal(emailsTo(warned, "You've reached").length, 0);
		const account = await m.Account.findById(warned.accountId).lean();
		await m.extraEmails.recordExtraEmails(account, 1);
		await m.extraEmails.recordExtraEmails(account, 0, { isLimitReached: true });
		assert.equal(emailsTo(warned, "You've used 80%").length, 1, "once a month");
		assert.equal(emailsTo(warned, "You've reached").length, 1);
		assert.match(emailsTo(warned, "You've reached")[0].text, /5 of your 5 extra emails this month/);
	});

	test("the owner sets the limit: 0 stops at the plan's emails, and never past 10 times the plan's", async () => {
		const user = await setup("set-limit@example.com", { emails: 3, contacts: 4 });
		assert.deepEqual(await as(user, () => m.billingActions.saveExtraEmailsLimit(null, form({ limit: "1,000" }))), { error: "limit: 30 at most, 10 times the plan's emails" });
		assert.deepEqual(await as(user, () => m.billingActions.saveExtraEmailsLimit(null, form({ limit: "abc" }))), { error: "Type a number of emails, or 0 for none" });
		assert.deepEqual(await as(user, () => m.billingActions.saveExtraEmailsLimit(null, form({ limit: "0" }))), { ok: true, limit: 0 });
		const id = await draftId(user);
		const refused = await as(user, () => m.campaigns.sendCampaign(id, {}));
		assert.equal(refused.code, "plan_limit_emails");
		assert.match(refused.error, /needs 4 emails and your plan has 3 left this month\. Upgrade to send/);
		assert.deepEqual(await as(user, () => m.billingActions.saveExtraEmailsLimit(null, form({ limit: "30" }))), { ok: true, limit: 30 });
		assert.equal((await m.Account.findById(user.accountId).lean()).extraEmails.limit, 30);
	});
});

async function draftId(user) {
	const url = await as(user, () => catchRedirect(m.campaigns.createCampaign(user.newsletterId)));
	const id = url.split("/").at(-1);
	await as(user, () => m.campaigns.saveCampaign(id, { subject: "Issue", previewText: "This week", body: "<p>Hello</p>" }));
	return id;
}

describe("reporting to Polar", () => {
	test("a report that fails is sent again with the same event id, so Polar never counts an email twice nor loses one", async () => {
		const user = await setup("flaky@example.com", { emails: 1, contacts: 3, limit: 10 });
		polar.state = "down";
		const { campaign } = await sendIssue(user);
		assert.equal(campaign.stats.sent, 3, "Polar being down never stops a send");
		let usage = await extra(user);
		assert.deepEqual([usage.counted, usage.reported, usage.pending.from, usage.pending.to, usage.due], [2, 0, 0, 2, true]);

		// Polar takes the event, but its answer is lost: the report stays pending.
		polar.state = "lost";
		assert.deepEqual(await m.extraEmails.reportDueExtraEmails(), { reported: 0, failed: 1 });
		assert.equal(billedAtPolar(user), 2);

		polar.state = "up";
		assert.deepEqual(await m.extraEmails.reportDueExtraEmails(), { reported: 2, failed: 0 });
		const ingests = polar.calls.filter(({ path }) => path === "/v1/events/ingest").map(({ body }) => body.events[0].external_id);
		assert.equal(new Set(ingests).size, 1, "the same event id every time");
		assert.equal(ingests.length, 3);
		assert.equal(billedAtPolar(user), 2, "Polar kept it once");
		usage = await extra(user);
		assert.deepEqual([usage.counted, usage.reported, usage.pending?.to, usage.due], [2, 2, undefined, undefined]);
	});

	test("emails counted while a report is on its way go in the next report, never in that one", async () => {
		const user = await setup("racing@example.com", { emails: 1, contacts: 2 });
		polar.state = "down";
		await sendIssue(user);
		await m.ExtraEmailUsage.updateOne({ accountId: user.accountId, _id: (await extra(user))._id }, { $inc: { counted: 5 } });
		polar.state = "up";
		assert.deepEqual(await m.extraEmails.reportDueExtraEmails(), { reported: 1, failed: 0 }, "the pending range first, as it was");
		assert.equal((await extra(user)).due, true);
		assert.deepEqual(await m.extraEmails.reportDueExtraEmails(), { reported: 5, failed: 0 });
		assert.equal(billedAtPolar(user), 6);
	});
});

describe("plans that stop at their own emails", () => {
	test("a free plan from an admin, a product without the price and Stripe keep the hard limit, and nothing goes to Polar", async () => {
		const admin = await signIn("admin@example.com");
		const free = await setup("comp@example.com", { emails: 2, contacts: 3 });
		assert.equal((await as(admin, () => m.admin.giveFreePlan(null, form({ accountId: String(free.accountId), plan: "starter" })))).ok, true);
		await m.Account.updateOne({ _id: free.accountId }, { $unset: { subscriptionStatus: 1, polarSubscriptionId: 1 } });
		assert.equal(m.plans.isOnFreePlan(await m.Account.findById(free.accountId).lean()), true);
		const unbillable = await setup("old-product@example.com", { emails: 2, contacts: 3, billable: false });
		const stripe = await setup("stripe@example.com", { emails: 2, contacts: 3 });
		await m.Account.updateOne({ _id: stripe.accountId }, { $unset: { polarSubscriptionId: 1, polarCustomerId: 1 } });

		for (const user of [free, unbillable, stripe]) {
			const id = await draftId(user);
			const refused = await as(user, () => m.campaigns.sendCampaign(id, {}));
			assert.equal(refused.code, "plan_limit_emails", `${user.email}: ${JSON.stringify(refused)}`);
			assert.match(refused.error, /Upgrade to send/);
			assert.equal(await extra(user), null);
		}
		assert.equal(polar.calls.some(({ path }) => path === "/v1/events/ingest"), false);
	});
});
