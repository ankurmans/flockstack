import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { getCleanupSettings } from "../lib/cleanup.js";
import { activate, anonymous, as, callApi, catchRedirect, form, signIn, startTestApp } from "./helpers/app.mjs";
import { flushAfter } from "./stubs/next-server.mjs";

// A new account names its newsletter at /welcome and is on the Free plan: the dashboard, the REST API and MCP all work
// at once, with no plan to pick, up to the Free plan's limits.
let app;
let m;

before(async () => {
	app = await startTestApp();
	m = {
		welcome: await import("../app/welcome/actions.js"),
		onboarding: await import("../lib/onboarding.js"),
		plans: await import("../lib/plans.js"),
		sharedSender: await import("../lib/shared-sender.js"),
		campaigns: await import("../app/(app)/campaigns/actions.js"),
		contacts: await import("../app/(app)/contacts/actions.js"),
		domains: await import("../app/(app)/domains/actions.js"),
		apiKeys: await import("../app/(app)/api-keys/actions.js"),
		newsletters: await import("../app/(app)/newsletters/actions.js"),
		mcpRoute: await import("../app/mcp/route.js"),
		Account: (await import("../models/Account.js")).default,
		Contact: (await import("../models/Contact.js")).default,
		Message: (await import("../models/Message.js")).default,
		Newsletter: (await import("../models/Newsletter.js")).default,
	};
});

after(() => app?.stop());

function welcome(user, fields) {
	return as(user, () => catchRedirect(m.welcome.completeOnboarding(null, form(fields))));
}

async function callTool(key, name, args) {
	const request = new Request("http://localhost:3000/mcp", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			"mcp-protocol-version": "2025-06-18",
			authorization: `Bearer ${key}`,
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
	});
	const text = await (await anonymous(() => m.mcpRoute.POST(request))).text();
	return JSON.parse(text.split("\n").find((line) => line.startsWith("data: ")).slice(6)).result;
}

function loadAccount(user) {
	return m.Account.findById(user.accountId).lean();
}

describe("/welcome", () => {
	test("a new account names its newsletter first, from the answers, then the dashboard opens", async () => {
		const user = await signIn("new@example.com");
		assert.equal(await m.onboarding.needsOnboarding(await loadAccount(user)), true);

		const answers = { name: "Field notes", description: "One idea a week.", fromName: "Jane", listSize: "growth", listSource: "Substack" };
		assert.equal(await welcome(user, answers), "/");
		const newsletter = await m.Newsletter.findOne({ accountId: user.accountId }).lean();
		assert.deepEqual(
			[newsletter.name, newsletter.slug, newsletter.description, newsletter.fromName, newsletter.fromEmail],
			["Field notes", "field-notes", "One idea a week.", "Jane", "hello@field-notes.flockstackmail.com"]
		);
		assert.deepEqual(getCleanupSettings(newsletter), { enabled: true, issues: 6, days: 180 }, "list cleanup starts on");
		const account = await loadAccount(user);
		assert.deepEqual([account.onboarding.listSize, account.onboarding.listSource], ["growth", "Substack"]);
		assert.ok(account.onboarding.completedAt);
		assert.equal(m.onboarding.getRecommendedPlanId(account), "growth", "the paywall starts on the plan for a weekly issue to the list");
		assert.equal(await m.onboarding.needsOnboarding(account), false);

		assert.equal(await welcome(user, { name: "Again" }), "/", "sent twice, it only finishes");
		assert.equal(await m.Newsletter.countDocuments({ accountId: user.accountId }), 1);
	});

	test("a name another newsletter has gets a numbered slug; no list starts on Free", async () => {
		const user = await signIn("second@example.com");
		assert.equal(await welcome(user, { name: "Field notes", listSize: "none", listSource: "Substack" }), "/");
		assert.equal((await m.Newsletter.findOne({ accountId: user.accountId }).lean()).slug, "field-notes-2");
		const account = await loadAccount(user);
		assert.equal(account.onboarding.listSource, undefined, "no list, no source");
		assert.equal(m.onboarding.getRecommendedPlanId(account), "free");
		assert.equal(m.onboarding.getRecommendedPlanId({ onboarding: { listSize: "more" } }), "max");
	});

	test("a name is needed, and answers that aren't choices aren't kept", async () => {
		const user = await signIn("blank@example.com");
		assert.deepEqual(await as(user, () => m.welcome.completeOnboarding(null, form({ name: "  " }))), { error: "Name your newsletter" });
		assert.equal(await welcome(user, { name: "Notes", listSize: "huge", listSource: "Myspace" }), "/");
		assert.equal((await loadAccount(user)).onboarding.listSize, undefined);
	});

	test("the list sizes are steps of the plans' subscribers, each suggesting the plan it names", () => {
		const suggest = (listSize) => m.onboarding.getRecommendedPlanId({ onboarding: { listSize } });
		const plan = (id) => m.plans.getPlan(id);
		// Each step's top is its plan's subscribers, and one issue a week to them (about 4.33 emails per subscriber a month)
		// fits the plan's emails.
		for (const [id, top] of [["free", 2_500], ["starter", 5_000], ["growth", 25_000], ["pro", 50_000], ["scale", 100_000]]) {
			const found = id === "free" ? m.plans.FREE_PLAN : plan(id);
			assert.equal(found.subscribers, top, id);
			// Free's 10,000 emails hold four issues a month to all 2,500 subscribers, not 4.33.
			if (id !== "free") assert.ok(Math.ceil(top * 4.33) <= found.emailsPerMonth, `a weekly issue to ${top} fits ${id}`);
		}
		assert.deepEqual(
			m.onboarding.LIST_SIZES.map(({ id, label }) => [label, suggest(id)]),
			[
				["Not yet", "free"],
				["Under 2,500", "free"],
				["2,500 to 5,000", "starter"],
				["5,000 to 25,000", "growth"],
				["25,000 to 50,000", "pro"],
				["50,000 to 100,000", "scale"],
				["Over 100,000", "max"],
			]
		);
	});

	test("while Max isn't on sale, Over 100,000 suggests the largest plan that is", () => {
		const onSale = m.plans.PLANS.filter(({ id }) => id !== "max");
		const suggest = (listSize) => m.onboarding.getRecommendedPlanId({ onboarding: { listSize } }, onSale);
		assert.deepEqual(["none", "free", "starter", "growth", "pro", "scale", "more"].map(suggest), ["free", "free", "starter", "growth", "pro", "scale", "scale"]);
	});

	test("an answer saved under earlier steps still names its plan, and one that names none starts on Free", () => {
		const suggest = (listSize) => m.onboarding.getRecommendedPlanId({ onboarding: { listSize } });
		// Accounts keep the id, whatever its label was when they picked it: starter was Under 10,000 for a while.
		assert.deepEqual(["starter", "growth", "pro", "scale", "more"].map(suggest), ["starter", "growth", "pro", "scale", "max"]);
		for (const listSize of [undefined, "", "Under 10,000", "enterprise"]) assert.equal(suggest(listSize), "free", String(listSize));
		assert.equal(m.onboarding.getRecommendedPlanId({}), "free", "an account from before onboarding asked");
	});

	test("the list's source is beehiiv, Mailchimp, Substack or somewhere else, and a source saved from earlier choices stays", async () => {
		assert.deepEqual([...m.onboarding.LIST_SOURCES, m.onboarding.OTHER_LIST_SOURCE], ["beehiiv", "Mailchimp", "Substack", "Somewhere else"]);
		const user = await signIn("elsewhere@example.com");
		assert.equal(await welcome(user, { name: "Elsewhere", listSize: "starter", listSource: "Somewhere else" }), "/");
		assert.equal((await loadAccount(user)).onboarding.listSource, "Somewhere else");

		const earlier = await signIn("from-kit@example.com");
		assert.equal(await welcome(earlier, { name: "From Kit", listSize: "growth", listSource: "Kit" }), "/");
		assert.equal((await loadAccount(earlier)).onboarding.listSource, undefined, "Kit isn't a choice anymore");
		await m.Account.updateOne({ _id: earlier.accountId }, { $set: { "onboarding.listSource": "Kit" } });
		await assert.doesNotReject((await m.Account.findById(earlier.accountId)).validate(), "an answer saved before still validates");
		assert.equal(await welcome(earlier, { name: "From Kit" }), "/", "sent again, it only finishes");
		const account = await loadAccount(earlier);
		assert.equal(account.onboarding.listSource, "Kit", "and leaves the saved answer as it was");
		assert.equal(m.onboarding.getRecommendedPlanId(account), "growth");
	});
});

describe("on the Free plan", () => {
	test("the dashboard sets up, writes and sends with no plan to pick: nothing answers subscription_required", async () => {
		const user = await signIn("trying@example.com");
		await welcome(user, { name: "Trying" });
		const newsletter = await m.Newsletter.findOne({ accountId: user.accountId }).lean();
		const saved = await as(user, () => m.newsletters.saveNewsletter(null, form({ id: String(newsletter._id), name: "Trying out", slug: "trying", postalAddress: "1 Main St, Paris" })));
		assert.equal(saved.ok, true);
		const url = await as(user, () => catchRedirect(m.campaigns.createCampaign(String(newsletter._id))));
		const id = url.split("/").at(-1);
		assert.deepEqual(await as(user, () => m.campaigns.saveCampaign(id, { subject: "Hello", previewText: "", body: "<p>Hi</p>" })), { ok: true });

		const results = [
			await as(user, () => m.campaigns.sendTestCampaign(id)),
			await as(user, () => m.contacts.importContacts({ newsletterId: newsletter._id, rows: [{ email: "a@example.org" }], consent: true })),
			await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Site" }))),
			await as(user, () => m.newsletters.sendWelcomeTest(newsletter._id)),
		];
		for (const [index, result] of results.entries()) assert.notEqual(result?.code, "subscription_required", String(index));
		assert.deepEqual(results[0], { ok: true }, "a test email goes out");
		assert.ok(results[2].key, "an API key opens");
		assert.equal((await loadAccount(user)).subscriptionStatus, undefined, "and the account never paid");
	});

	test("the dashboard adds contacts by hand with no cap but the plan's, active at once with the signup checks and no email", async () => {
		const user = await signIn("contacts-trial@example.com");
		await welcome(user, { name: "Contacts trial" });
		const newsletterId = String((await m.Newsletter.findOne({ accountId: user.accountId }).lean())._id);
		const add = (email, consent = "on") => as(user, () => m.contacts.addContact(null, form({ newsletterId, email, ...(consent && { consent }) })));

		assert.deepEqual(await add("me@example.org", null), { error: "Check that this person agreed to get your emails" }, "a refusal doesn't count");
		assert.deepEqual(await add("me@example.org"), { email: "me@example.org", status: "active" }, "though new newsletters ask signups to confirm");
		assert.deepEqual(await add("jane.doe@gmial.com"), { error: "Did you mean jane.doe@gmail.com?" });
		assert.deepEqual(await add("me@example.org"), { error: "me@example.org is already a contact" });
		for (const email of ["a", "b", "c", "d", "e", "f"]) assert.equal((await add(`${email}@example.org`)).status, "active", email);
		await flushAfter();
		assert.equal(await m.Message.countDocuments({ accountId: user.accountId }), 0, "no welcome email on, so no email");
		assert.equal(await m.Contact.countDocuments({ accountId: user.accountId }), 7);
	});

	test("a contact added by hand gets the welcome email from the first day", async () => {
		const user = await signIn("welcome-trial@example.com");
		await welcome(user, { name: "Welcome trial" });
		const { _id, name, slug } = await m.Newsletter.findOne({ accountId: user.accountId }).lean();
		const newsletterId = String(_id);
		const settings = { id: newsletterId, name, slug, postalAddress: "1 Main St, Paris", welcomeEnabled: "on", welcomeSubject: "Welcome", welcomeMarkdown: "Thanks." };
		assert.equal((await as(user, () => m.newsletters.saveNewsletter(null, form(settings)))).ok, true, "signups don't confirm, so the welcome email is on");
		const add = (email) => as(user, () => m.contacts.addContact(null, form({ newsletterId, email, consent: "on" })));

		assert.equal((await add("early@example.org")).status, "active");
		await flushAfter();
		const messages = await m.Message.find({ accountId: user.accountId }).lean();
		assert.deepEqual(messages.map(({ kind, email, status }) => [kind, email, status]), [["welcome", "early@example.org", "sent"]]);
	});

	test("the REST API and MCP work on it too, and keep working when a paid plan ends", async () => {
		const user = await signIn("api-trial@example.com");
		await welcome(user, { name: "API trial" });
		await activate(user);
		const { key } = await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Site" })));
		await m.Account.updateOne({ _id: user.accountId }, { $set: { subscriptionStatus: "canceled" } });
		assert.equal((await callApi("GET", "/api/v1/newsletters", { key })).status, 200);

		const signup = await callApi("POST", "/api/v1/contacts", { key, body: { email: "late@example.org" } });
		assert.equal(signup.status, 201);
		const tool = await callTool(key, "add_contact", { email: "later@example.org" });
		assert.notEqual(tool.isError, true);
		assert.equal(await m.Contact.countDocuments({ accountId: user.accountId }), 2);
	});
});
