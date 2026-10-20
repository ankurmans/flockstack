import assert from "node:assert/strict";
import { jsonRequest } from "./app.mjs";
import { api, postPaymentEvent } from "./shop.mjs";
import { runWithRequest } from "../stubs/next-headers.mjs";
import { published } from "../stubs/qstash.mjs";
import { sent as emails } from "../stubs/ses.mjs";

// What the paid features' tests share: tiers set up through the API, a reader subscribing through the subscribe page's form
// and Stripe completing the Checkout Session, and the queue's jobs run by calling their routes.
export const DAY = 86_400;
let visitors = 0;
let processed = 0;

export async function setTier(user, fields = {}) {
	const response = await api(user, "PATCH", `/newsletters/${user.slug}/paid-tier`, { enabled: true, monthlyCents: 800, yearlyCents: 8000, ...fields });
	assert.equal(response.status, 200, JSON.stringify(response.body));
	return response.body;
}

export async function addTier(user, fields = {}) {
	const response = await api(user, "POST", `/newsletters/${user.slug}/tiers`, { name: "Supporter", yearlyCents: 12000, ...fields });
	assert.equal(response.status, 201, JSON.stringify(response.body));
	return response.body;
}

export async function listTiers(user) {
	const response = await api(user, "GET", `/newsletters/${user.slug}/tiers`);
	assert.equal(response.status, 200, JSON.stringify(response.body));
	return response.body.tiers;
}

// What the subscribe page's form sends, from a visitor's network.
export async function subscribe(user, fields = {}, { ip = `192.0.2.${(++visitors % 250) + 1}` } = {}) {
	const actions = await import("../../app/archive/shop-actions.js");
	const data = new FormData();
	for (const [key, value] of Object.entries({ newsletter: user.slug, option: "month", email: "reader@example.net", ...fields })) data.set(key, String(value));
	return runWithRequest({ headers: { "x-forwarded-for": ip } }, () => actions.subscribePaid(null, data));
}

export function sessionOf(fake, url) {
	return [...fake.sessions.values()].find((candidate) => candidate.url === url);
}

// The reader completes the Checkout Session at url: Stripe makes the subscription and sends checkout.session.completed.
export async function completeCheckout(fake, user, url, { email = "reader@example.net", interval = "month", intervalCount = 1, status = "active", customFields, ...subscription } = {}) {
	const session = sessionOf(fake, url);
	assert.ok(session, "the session is in Stripe");
	const customer = fake.addCustomer({ email });
	if (session.mode === "payment") {
		fake.paidSession(session.id, { customer: null, customer_details: { email }, payment_status: "paid", ...(customFields && { custom_fields: customFields }) });
		const event = fake.event("checkout.session.completed", session, { account: user.stripeAccountId });
		return { session, customer, event, result: await postPaymentEvent(event) };
	}
	const created = fake.addSubscription({
		customer: customer.id,
		status,
		metadata: session.subscription_data.metadata,
		items: { data: [{ id: "si_1", price: { recurring: { interval, interval_count: intervalCount } } }] },
		...subscription,
	});
	fake.paidSession(session.id, { mode: "subscription", subscription: created.id, customer: customer.id, customer_details: { email }, payment_status: "paid", ...(customFields && { custom_fields: customFields }) });
	const event = fake.event("checkout.session.completed", session, { account: user.stripeAccountId });
	return { session, customer, subscription: created, event, result: await postPaymentEvent(event) };
}

export async function subscribeAndPay(fake, user, fields = {}, completion = {}) {
	const answer = await subscribe(user, fields);
	assert.ok(answer.url, JSON.stringify(answer));
	return completeCheckout(fake, user, answer.url, { email: fields.email ?? "reader@example.net", ...completion });
}

export function readerOf(m, user, email) {
	return m.Contact.findOne({ accountId: user.accountId, email }).lean();
}

export async function runJobs(m) {
	while (processed < published.length) {
		const { url, body } = published[processed++];
		if (url.endsWith("/api/jobs/send-batch")) await m.sendBatchRoute.POST(jsonRequest(url, { method: "POST", body }));
	}
}

export async function sendIssue(m, user, { audience, content = "Hello readers.", subject = "Issue", paidTier, ...send } = {}) {
	const created = await api(user, "POST", "/campaigns", { subject, previewText: "This week", content, ...(audience && { audience }), ...(paidTier !== undefined && { paidTier }) });
	assert.equal(created.status, 201, JSON.stringify(created.body));
	const before = emails.length;
	const response = await api(user, "POST", `/campaigns/${created.body.id}/send`, send);
	assert.equal(response.status, 200, JSON.stringify(response.body));
	await runJobs(m);
	return { id: created.body.id, emails: emails.slice(before), campaign: response.body };
}

export function addReader(m, user, email, fields = {}) {
	return m.Contact.create({ accountId: user.accountId, newsletterId: user.newsletterId, email, status: "active", subscribedAt: new Date(), ...fields });
}

// Skips the jobs published so far: a test that only looks at what it publishes next.
export function skipJobs() {
	processed = published.length;
}
