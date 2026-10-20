import assert from "node:assert/strict";
import { activate, addSentIssue, anonymous, as, callApi, catchRedirect, form, mockStripe, signIn } from "./app.mjs";
import { runWithRequest } from "../stubs/next-headers.mjs";
import { createFakeStripe } from "../stubs/stripe-connect.mjs";

// What the commerce tests share: a seller with a newsletter whose website is online, an API key and a connected Stripe
// account (in tests/stubs/stripe-connect.mjs), and the calls a buyer, Stripe and the REST API make.
export const WEBHOOK_SECRET = "whsec_test_payments_secret";
const PDF = Buffer.from("%PDF-1.4 a made-up product file");

export function installFakeStripe() {
	const fake = createFakeStripe();
	mockStripe(fake.handler);
	return fake;
}

// ready: its Stripe account takes charges. Otherwise it has none connected.
// free: the account is on the Free plan, without a paid FlockStack subscription.
export async function createSeller(email, { fake, ready = true, requireConfirmation = false, free = false } = {}) {
	const newsletters = await import("../../app/(app)/newsletters/actions.js");
	const apiKeys = await import("../../app/(app)/api-keys/actions.js");
	const Account = (await import("../../models/Account.js")).default;
	const user = await signIn(email);
	if (!free) await activate(user);
	user.slug = email.split("@")[0].replace(/[^a-z0-9]/g, "-");
	const fields = { name: `${user.slug} news`, slug: user.slug, postalAddress: "1 Main St, Paris", archiveEnabled: "on", ...(requireConfirmation && { requireConfirmation: "on" }) };
	const url = await as(user, () => catchRedirect(newsletters.saveNewsletter(null, form(fields))));
	user.newsletterId = url.split("/").at(-1);
	user.key = (await as(user, () => apiKeys.createApiKey(null, form({ name: "Agent", level: "full" })))).key;
	await addSentIssue(user);
	if (ready) {
		const stripeAccountId = `acct_${user.slug}`;
		fake?.accounts.set(stripeAccountId, { id: stripeAccountId, charges_enabled: true, payouts_enabled: true, details_submitted: true, country: "US" });
		await Account.updateOne(
			{ _id: user.accountId },
			{ $set: { "payments.stripeAccountId": stripeAccountId, "payments.chargesEnabled": true, "payments.payoutsEnabled": true, "payments.detailsSubmitted": true } }
		);
		user.stripeAccountId = stripeAccountId;
	}
	user.account = await Account.findById(user.accountId).lean();
	return user;
}

// The REST API, checking every successful answer against the action's schema like the API tests do.
export async function api(user, method, path, body) {
	const rest = await import("../../lib/api/rest.js");
	const response = await callApi(method, `/api/v1${path}`, { key: user.key, body });
	if (response.status < 300) {
		const segments = new URL(path, "http://x").pathname.split("/").filter(Boolean).map(decodeURIComponent);
		const { action } = rest.matchRoute(method, segments);
		const checked = action.output.safeParse(response.body);
		assert.ok(checked.success, `${action.name} answered outside its schema: ${checked.error?.message}`);
	}
	return response;
}

export function assertError(response, status, code) {
	assert.equal(response.status, status, JSON.stringify(response.body));
	assert.equal(response.body.error.code, code, response.body.error.message);
	return response.body.error.message;
}

// A product on sale: created, its file uploaded, put on sale.
export async function createProduct(user, fields = {}, { activate: shouldActivate = true, file = PDF } = {}) {
	const created = await api(user, "POST", "/products", { title: "Launch checklist", description: "Everything before your first issue.", priceCents: 1900, ...fields });
	assert.equal(created.status, 201, JSON.stringify(created.body));
	if (file) {
		const uploaded = await api(user, "POST", `/products/${created.body.id}/file`, { base64: file.toString("base64"), fileName: "launch-checklist.pdf", contentType: "application/pdf" });
		assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
	}
	if (!shouldActivate) return (await api(user, "GET", `/products/${created.body.id}`)).body;
	const active = await api(user, "PATCH", `/products/${created.body.id}`, { status: "active" });
	assert.equal(active.status, 200, JSON.stringify(active.body));
	return active.body;
}

export const PRODUCT_FILE = PDF;

// A webhook call signed like Stripe signs it.
export async function postPaymentEvent(event, { secret = WEBHOOK_SECRET, timestamp = Math.floor(Date.now() / 1000), header } = {}) {
	const { signStripePayload } = await import("../../lib/payments/signature.js");
	const route = await import("../../app/api/webhooks/payments/route.js");
	const body = JSON.stringify(event);
	const signature = header ?? (await signStripePayload({ secret, body, timestamp }));
	const response = await anonymous(() => route.POST(new Request("http://localhost:3000/api/webhooks/payments", { method: "POST", headers: { "stripe-signature": signature }, body })));
	return { status: response.status, body: await response.json() };
}

// A reader buying a product from the shop page's form, from a network of their own unless ip says otherwise; resolves to
// what the form's action answers.
let visitors = 0;
export async function buy(user, productSlug, fields = {}, { ip = `192.0.2.${(++visitors % 250) + 1}` } = {}) {
	const actions = await import("../../app/archive/shop-actions.js");
	return runWithRequest({ headers: { "x-forwarded-for": ip } }, () => actions.buyProduct(null, form({ newsletter: user.slug, product: productSlug, ...fields })));
}

// Stripe telling the webhook the buyer paid for a session (as the fake recorded it).
export async function payForSession(fake, user, url, { email = "buyer@example.net", name = "Sam Buyer", amount } = {}) {
	const session = [...fake.sessions.values()].find((candidate) => candidate.url === url);
	assert.ok(session, "the session is in Stripe");
	const unitAmount = Number(session.line_items?.[0]?.price_data?.unit_amount ?? 0);
	fake.paidSession(session.id, { customer_details: { email, name }, amount_total: amount ?? unitAmount, currency: session.line_items?.[0]?.price_data?.currency ?? "usd" });
	const event = fake.event("checkout.session.completed", session, { account: user.stripeAccountId });
	return { session, event, result: await postPaymentEvent(event) };
}
