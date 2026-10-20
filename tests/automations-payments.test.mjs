import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { startTestApp } from "./helpers/app.mjs";
import { WEBHOOK_SECRET, api, buy, createProduct, createSeller, installFakeStripe, payForSession, postPaymentEvent } from "./helpers/shop.mjs";
import { runWithRequest } from "./stubs/next-headers.mjs";

// The triggers that come from a reader paying: upgrading, dropping to free and buying a product.
let app;
let fake;
let m;
let counter = 0;
let visitors = 0;

before(async () => {
	app = await startTestApp({ STRIPE_PAYMENTS_WEBHOOK_SECRET: WEBHOOK_SECRET, QSTASH_CURRENT_SIGNING_KEY: "sig-current", QSTASH_NEXT_SIGNING_KEY: "sig-next" });
	m = {
		automations: await import("../lib/automations.js"),
		Contact: (await import("../models/Contact.js")).default,
		Enrollment: (await import("../models/AutomationEnrollment.js")).default,
	};
});

after(() => app?.stop());

beforeEach(() => {
	fake = installFakeStripe();
});

async function seller() {
	const user = await createSeller(`pay-auto${++counter}@example.com`, { fake });
	const tier = await api(user, "PATCH", `/newsletters/${user.slug}/paid-tier`, { enabled: true, monthlyCents: 800, yearlyCents: 8000 });
	assert.equal(tier.status, 200, JSON.stringify(tier.body));
	return user;
}

async function automation(user, trigger, steps = [{ type: "add_tag", tag: "ran" }], name = "On payment") {
	const created = await api(user, "POST", "/automations", { name, trigger, steps });
	assert.equal(created.status, 201, JSON.stringify(created.body));
	const activated = await api(user, "POST", `/automations/${created.body.id}/activate`);
	assert.equal(activated.status, 200, JSON.stringify(activated.body));
	return created.body;
}

const enrollmentsOf = (user, created) => m.Enrollment.find({ accountId: user.accountId, automationId: created.id }).lean();
const reader = (user, email) => m.Contact.findOne({ accountId: user.accountId, email }).lean();

async function subscribeAndPay(user, email) {
	const actions = await import("../app/archive/shop-actions.js");
	const data = new FormData();
	for (const [key, value] of Object.entries({ newsletter: user.slug, interval: "month", email })) data.set(key, value);
	const { url } = await runWithRequest({ headers: { "x-forwarded-for": `192.0.2.${(++visitors % 250) + 1}` } }, () => actions.subscribePaid(null, data));
	const session = [...fake.sessions.values()].find((candidate) => candidate.url === url);
	const customer = fake.addCustomer({ email });
	const subscription = fake.addSubscription({
		customer: customer.id,
		status: "active",
		metadata: session.subscription_data.metadata,
		items: { data: [{ id: "si_1", price: { recurring: { interval: "month" } } }] },
	});
	fake.paidSession(session.id, { mode: "subscription", subscription: subscription.id, customer: customer.id, customer_details: { email }, payment_status: "paid" });
	const result = await postPaymentEvent(fake.event("checkout.session.completed", session, { account: user.stripeAccountId }));
	assert.equal(result.status, 200, JSON.stringify(result.body));
	return subscription;
}

describe("a reader paying for the paid tier", () => {
	test("upgrading starts the automations for upgrades, and dropping to free those for downgrades, each time", async () => {
		const user = await seller();
		const upgraded = await automation(user, { type: "upgraded" }, [{ type: "add_tag", tag: "welcome-paid" }], "Upgraded");
		const downgraded = await automation(user, { type: "downgraded" }, [{ type: "add_tag", tag: "come-back" }], "Downgraded");
		const subscription = await subscribeAndPay(user, "reader@example.net");
		assert.equal((await reader(user, "reader@example.net")).tier, "paid");
		assert.equal((await enrollmentsOf(user, upgraded)).length, 1);
		assert.equal((await enrollmentsOf(user, downgraded)).length, 0);

		const end = (type, object) => postPaymentEvent(fake.event(type, object, { account: user.stripeAccountId }));
		Object.assign(fake.subscriptions.get(subscription.id), { status: "canceled" });
		assert.equal((await end("customer.subscription.deleted", { id: subscription.id })).status, 200);
		assert.equal((await reader(user, "reader@example.net")).tier, "free");
		assert.equal((await enrollmentsOf(user, downgraded)).length, 1);
		assert.equal((await enrollmentsOf(user, upgraded)).length, 1, "dropping to free doesn't start the other");

		Object.assign(fake.subscriptions.get(subscription.id), { status: "active" });
		await end("customer.subscription.updated", { id: subscription.id });
		assert.equal((await reader(user, "reader@example.net")).tier, "paid");
		assert.equal((await enrollmentsOf(user, upgraded)).length, 2, "upgrading again starts it again");

		await m.automations.runAutomations();
		assert.deepEqual((await reader(user, "reader@example.net")).tags.sort(), ["come-back", "welcome-paid"]);
	});

	test("a subscription event repeated changes nothing and starts nothing again", async () => {
		const user = await seller();
		const upgraded = await automation(user, { type: "upgraded" });
		const subscription = await subscribeAndPay(user, "repeat@example.net");
		await postPaymentEvent(fake.event("customer.subscription.updated", { id: subscription.id }, { account: user.stripeAccountId }));
		await postPaymentEvent(fake.event("customer.subscription.updated", { id: subscription.id }, { account: user.stripeAccountId }));
		assert.equal((await enrollmentsOf(user, upgraded)).length, 1);
	});
});

describe("a reader buying a product", () => {
	test("starts the automations for any product, or for that one, for a buyer on the list", async () => {
		const user = await seller();
		const first = await createProduct(user, { title: "Template pack", priceCents: 2900 });
		const second = await createProduct(user, { title: "Workbook", priceCents: 1900 });
		const anyProduct = await automation(user, { type: "product_bought" }, [{ type: "add_tag", tag: "customer" }], "Any product");
		const workbook = await automation(user, { type: "product_bought", product: second.id }, [{ type: "add_tag", tag: "workbook-buyer" }], "Workbook buyers");
		assert.match(workbook.summary, /A reader buys Workbook/);

		const pay = async (product, email, extra = {}) => {
			const answer = await buy(user, product.slug, { email, ...extra });
			return payForSession(fake, user, answer.url, { email });
		};
		await pay(first, "sam@example.net", { addToList: "on" });
		assert.equal((await enrollmentsOf(user, anyProduct)).length, 1);
		assert.equal((await enrollmentsOf(user, workbook)).length, 0, "another product");
		await pay(second, "sam@example.net", { addToList: "on" });
		assert.equal((await enrollmentsOf(user, anyProduct)).length, 2, "each purchase is its own");
		assert.equal((await enrollmentsOf(user, workbook)).length, 1);

		await pay(second, "stranger@example.net");
		assert.equal(await reader(user, "stranger@example.net"), null, "not on the list");
		assert.equal((await enrollmentsOf(user, anyProduct)).length, 2, "nobody to start it for");

		await m.automations.runAutomations();
		assert.deepEqual((await reader(user, "sam@example.net")).tags.sort(), ["customer", "workbook-buyer"]);
	});

	test("a payment event delivered twice starts it once", async () => {
		const user = await seller();
		const product = await createProduct(user, { title: "Template pack", priceCents: 2900 });
		const created = await automation(user, { type: "product_bought" });
		const answer = await buy(user, product.slug, { email: "twice@example.net", addToList: "on" });
		const { event } = await payForSession(fake, user, answer.url, { email: "twice@example.net" });
		await postPaymentEvent(event);
		assert.equal((await enrollmentsOf(user, created)).length, 1);
	});
});
