import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { as, catchRedirect, form, startTestApp } from "./helpers/app.mjs";
import { findWhere, renderShallow } from "./helpers/shallow.mjs";
import { WEBHOOK_SECRET, api, buy, createProduct, createSeller, installFakeStripe, payForSession } from "./helpers/shop.mjs";
import { published } from "./stubs/qstash.mjs";
import { sent as emails } from "./stubs/ses.mjs";

// The dashboard's side of selling: the Products, Orders and Payments pages and their server actions, which run the same
// actions as the API, and the send step's audience.
let app;
let m;
let fake;
let counter = 0;

async function seller(options) {
	return createSeller(`dash${++counter}@example.com`, { fake, ...options });
}

async function render(user, page, props = {}) {
	const element = await as(user, () => page(props));
	return renderToStaticMarkup(createElement(m.TooltipProvider, null, element));
}

before(async () => {
	app = await startTestApp({ STRIPE_PAYMENTS_WEBHOOK_SECRET: WEBHOOK_SECRET, QSTASH_CURRENT_SIGNING_KEY: "sig-current", QSTASH_NEXT_SIGNING_KEY: "sig-next" });
	m = {
		products: await import("../app/(app)/products/actions.js"),
		orders: await import("../app/(app)/orders/actions.js"),
		payments: await import("../app/(app)/payments/actions.js"),
		campaigns: await import("../app/(app)/campaigns/actions.js"),
		productsPage: (await import("../app/(app)/products/page.js")).default,
		productPage: (await import("../app/(app)/products/[id]/page.js")).default,
		ordersPage: (await import("../app/(app)/orders/page.js")).default,
		paymentsPage: (await import("../app/(app)/payments/page.js")).default,
		campaignPage: (await import("../app/(app)/campaigns/[id]/page.js")).default,
		TooltipProvider: (await import("../components/ui/tooltip.jsx")).TooltipProvider,
		Contact: (await import("../models/Contact.js")).default,
		Product: (await import("../models/Product.js")).default,
		FormProduct: (await import("../components/FormProduct.jsx")).default,
		productSlug: await import("../lib/product-slug.js"),
	};
});

after(() => app?.stop());

beforeEach(() => {
	fake = installFakeStripe();
});

describe("products", () => {
	test("are made, edited, put on sale, taken off and archived from the dashboard's actions", async () => {
		const user = await seller();
		const priceError = { error: "Enter a price of 1 or more, like 19 or 19.50" };
		assert.deepEqual(await as(user, () => m.products.createProduct(null, form({ newsletter: user.newsletterId, title: "Guide", price: "abc", currency: "usd" }))), priceError);
		assert.deepEqual(await as(user, () => m.products.createProduct(null, form({ newsletter: user.newsletterId, title: "Guide", price: "0.20", currency: "usd" }))), priceError, "the form's words, not priceCents");

		const url = await as(user, () => catchRedirect(m.products.createProduct(null, form({ newsletter: user.newsletterId, title: "Guide", price: "19,50", currency: "eur", description: "A guide." }))));
		const id = url.split("/").at(-1);
		assert.equal(url, `/products/${id}`);
		const stored = await m.Product.findOne({ accountId: user.accountId, _id: id }).lean();
		assert.deepEqual([stored.priceCents, stored.currency, stored.status], [1950, "eur", "draft"]);

		const saved = await as(user, () => m.products.saveProduct(null, form({ id, title: "Guide v2", description: "Better.", price: "24", currency: "eur", slug: "guide-v2", imageUrl: "" })));
		assert.deepEqual(saved, { ok: true, slug: "guide-v2" });
		const fields = { id, title: "Guide v2", description: "Better.", price: "24", currency: "eur", slug: "guide-v2", imageUrl: "" };
		assert.deepEqual(await as(user, () => m.products.saveProduct(null, form({ ...fields, slug: "Guide two!" }))), { ok: true, slug: "guide-two" });
		assert.deepEqual(await as(user, () => m.products.saveProduct(null, form({ ...fields, slug: "!!!" }))), {
			error: "Page address: use letters or digits, like bird-stickers",
		});
		assert.deepEqual(await as(user, () => m.products.saveProduct(null, form({ ...fields, imageUrl: "http://example.com/cover.png" }))), { error: "Cover image: use an https:// link" });
		assert.match((await as(user, () => m.products.publishProduct(id))).error, /^Upload the file/, "no file, no sale");

		const bytes = Buffer.from("zip bytes").toString("base64");
		assert.equal((await api(user, "POST", `/products/${id}/file`, { base64: bytes, fileName: "guide.zip" })).status, 200);
		assert.deepEqual(await as(user, () => m.products.publishProduct(id)), { ok: true });
		assert.equal((await api(user, "GET", `/products/${id}`)).body.status, "active");
		assert.deepEqual(await as(user, () => m.products.unpublishProduct(id)), { ok: true });
		assert.equal((await api(user, "GET", `/products/${id}`)).body.status, "draft");
		assert.deepEqual(await as(user, () => m.products.archiveProduct(id)), { ok: true });
		assert.equal((await api(user, "GET", `/products/${id}`)).body.status, "archived");
		assert.deepEqual(await as(user, () => m.products.unpublishProduct(id)), { ok: true }, "restored");
	});

	test("a page address typed as words becomes one; a reserved or taken one is refused in plain words", async () => {
		const user = await seller();
		const first = await createProduct(user, { title: "Stickers", priceCents: 500 });
		const second = await createProduct(user, { title: "Posters", priceCents: 900 });
		const fields = (product, slug) => form({ id: product.id, title: product.title, description: "", price: "9", currency: "usd", slug, imageUrl: "" });
		const save = (product, slug) => as(user, () => m.products.saveProduct(null, fields(product, slug)));

		assert.deepEqual(await save(first, "  Bird Stickers Two "), { ok: true, slug: "bird-stickers-two" });
		assert.equal((await api(user, "GET", `/products/${first.id}`)).body.slug, "bird-stickers-two");
		assert.deepEqual(await save(first, "Café Crème — Édition 2"), { ok: true, slug: "cafe-creme-edition-2" });
		assert.deepEqual(await save(second, "Café crème, édition 2"), { error: "Another product of this newsletter uses the page address /shop/cafe-creme-edition-2" });
		assert.deepEqual(await save(second, "Checkout"), { error: "Page address: /shop/checkout is kept for the shop's own pages. Pick another address" });
		assert.equal((await api(user, "GET", `/products/${second.id}`)).body.slug, "posters", "a refused address changes nothing");

		const reserved = await api(user, "PATCH", `/products/${second.id}`, { slug: "cart" });
		assert.equal(reserved.status, 400);
		assert.equal(reserved.body.error.message, "slug: /shop/cart is kept for the shop's own pages. Pick another address");
		const taken = await api(user, "POST", "/products", { newsletter: user.newsletterId, title: "Copy", priceCents: 500, slug: "cafe-creme-edition-2" });
		assert.deepEqual([taken.status, taken.body.error.message], [409, "Another product of this newsletter uses the slug cafe-creme-edition-2"]);
		const named = await api(user, "POST", "/products", { newsletter: user.newsletterId, title: "Cart", priceCents: 500 });
		assert.equal(named.body.slug, "cart-2", "a title that makes a reserved address gets a number");
	});

	test("the page address field shows the address it makes, and makes it when it's left", async () => {
		const product = { id: "p1", title: "Stickers", description: "", priceCents: 500, currency: "usd", slug: "Bird Stickers Two", status: "draft", sales: 0, revenueCents: 0 };
		const { tree, updates } = renderShallow(createElement(m.FormProduct, { product, payments: { ready: true }, maxFileMb: 15 }), { expand: ["InputSlug"] });
		const [input] = findWhere(tree, (node) => node.props?.name === "slug");
		const [preview] = findWhere(tree, (node) => node.props?.["data-slug-preview"]);
		assert.equal([preview.props.children].flat().join(""), "/shop/bird-stickers-two");
		input.props.onBlur();
		assert.deepEqual(updates, ["bird-stickers-two"]);
		assert.equal(m.productSlug.toProductSlug("Bird Stickers Two"), "bird-stickers-two");
		assert.equal(m.productSlug.getProductSlugProblem("bird-stickers-two"), null);
	});

	test("show on their pages, with what they sold", async () => {
		const user = await seller();
		const product = await createProduct(user, { title: "Template pack", priceCents: 2900 });
		const { url } = await buy(user, product.slug);
		await payForSession(fake, user, url, { email: "page-buyer@example.net" });

		const list = await render(user, m.productsPage);
		assert.match(list, /Template pack/);
		assert.match(list, /\$29\.00/);
		assert.match(list, /On sale/);
		assert.match(list, /1 order/);

		const page = await render(user, m.productPage, { params: Promise.resolve({ id: product.id }) });
		assert.match(page, /Template pack/);
		assert.match(page, /launch-checklist\.pdf/);
		assert.match(page, new RegExp(`https://${user.slug}\\.flockstackmail\\.com/shop/template-pack`));
		assert.match(page, /Take off sale/);
		assert.match(page, /FlockStack takes no cut/);

		const orders = await render(user, m.ordersPage, { searchParams: Promise.resolve({}) });
		assert.match(orders, /page-buyer@example\.net/);
		assert.match(orders, /Link sent/);
		assert.match(orders, /Resend link/);
		assert.match(orders, /Paid/);
	});

	test("are only for the account that made them", async () => {
		const owner = await seller();
		const stranger = await seller();
		const product = await createProduct(owner);
		await assert.rejects(render(stranger, m.productPage, { params: Promise.resolve({ id: product.id }) }), /NEXT_NOT_FOUND/);
		assert.match((await as(stranger, () => m.products.publishProduct(product.id))).error, /not found/i);
		assert.match(await render(stranger, m.productsPage), /No products yet/);
	});

	test("pages say what is missing before payments are ready", async () => {
		const user = await seller({ ready: false });
		const draft = await createProduct(user, {}, { activate: false });
		assert.match(await render(user, m.productsPage), /Connect your Stripe account to take payments/);
		const page = await render(user, m.productPage, { params: Promise.resolve({ id: draft.id }) });
		assert.match(page, /Connect your Stripe account to take payments/);
		assert.match(page, /disabled=""[^>]*>Put on sale/);
		assert.match((await as(user, () => m.products.publishProduct(draft.id))).error, /Connect your Stripe account/);
	});
});

describe("orders", () => {
	test("can be resent from the dashboard", async () => {
		const user = await seller();
		const product = await createProduct(user);
		const { url } = await buy(user, product.slug);
		await payForSession(fake, user, url, { email: "resend@example.net" });
		const [{ id }] = (await api(user, "GET", "/orders")).body.orders;
		const before = emails.length;
		assert.deepEqual(await as(user, () => m.orders.resendOrder(id)), { ok: true });
		assert.equal(emails.length - before, 1);
		assert.match((await as(user, () => m.orders.resendOrder("6a0000000000000000000009"))).error, /not found/i);
	});
});

describe("payments", () => {
	test("the page asks Stripe for the status when the owner comes back from onboarding", async () => {
		const user = await seller({ ready: false });
		assert.match(await render(user, m.paymentsPage, { searchParams: Promise.resolve({}) }), /Connect your Stripe account to take payments/);
		const url = await as(user, () => catchRedirect(m.payments.connectStripe()));
		assert.match(url, /^https:\/\/connect\.stripe\.test\/onboard\/acct_test_/);
		const { payments } = await (await import("../models/Account.js")).default.findById(user.accountId).lean();
		assert.match(payments.stripeAccountId, /^acct_test_/);

		const requestsBefore = fake.requests.length;
		assert.match(await render(user, m.paymentsPage, { searchParams: Promise.resolve({}) }), /Continue setup/);
		assert.equal(fake.requests.length, requestsBefore, "a plain visit asks nothing of Stripe");
		fake.completeOnboarding(payments.stripeAccountId);
		const back = await render(user, m.paymentsPage, { searchParams: Promise.resolve({ connect: "return" }) });
		assert.match(back, /Connected, ready for payments/);
		assert.match(back, /FlockStack takes no cut/);
		assert.deepEqual(await as(user, () => m.payments.refreshPayments()), { ok: true });
	});

	test("Stripe being down sends the owner back with a message", async () => {
		const user = await seller({ ready: false });
		fake.failNext("POST /v1/accounts");
		assert.equal(await as(user, () => catchRedirect(m.payments.connectStripe())), "/payments?error=unavailable");
		assert.match(await render(user, m.paymentsPage, { searchParams: Promise.resolve({ error: "unavailable" }) }), /Stripe can(?:'|&#x27;)t be reached right now/);
	});

	test("the paid tier is set from the page's form", async () => {
		const user = await seller();
		const fields = { newsletterId: user.newsletterId, enabled: "on", monthly: "8", yearly: "80.50", currency: "gbp", trialDays: "14", pitch: "Everything, first." };
		assert.deepEqual(await as(user, () => m.payments.savePaidTier(null, form(fields))), { ok: true });
		const tier = (await api(user, "GET", `/newsletters/${user.slug}/paid-tier`)).body;
		assert.deepEqual([tier.enabled, tier.monthlyCents, tier.yearlyCents, tier.currency, tier.trialDays, tier.pitch], [true, 800, 8050, "gbp", 14, "Everything, first."]);
		const page = await render(user, m.paymentsPage, { searchParams: Promise.resolve({}) });
		assert.match(page, /value="8"/);
		assert.match(page, /value="80\.50"/);
		assert.match(page, new RegExp(`https://${user.slug}\\.flockstackmail\\.com/subscribe`));
		const priceError = { error: "Enter prices of 1 or more, like 8 or 8.50, or leave a plan empty" };
		assert.deepEqual(await as(user, () => m.payments.savePaidTier(null, form({ ...fields, monthly: "x" }))), priceError);
		assert.deepEqual(await as(user, () => m.payments.savePaidTier(null, form({ ...fields, monthly: "0.20" }))), priceError, "the form's words, not monthlyCents");
		assert.deepEqual(await as(user, () => m.payments.savePaidTier(null, form({ ...fields, monthly: "", yearly: "" }))), { error: "Set a monthly or a yearly price first" });
		const { enabled, ...off } = fields;
		assert.deepEqual(await as(user, () => m.payments.savePaidTier(null, form(off))), { ok: true });
		assert.equal((await api(user, "GET", `/newsletters/${user.slug}/paid-tier`)).body.enabled, false, "an unticked box turns it off");
	});
});

describe("the paid tiers' forms", () => {
	test("add, change, order and delete tiers, and show them on the page", async () => {
		const user = await seller();
		const fields = { newsletterId: user.newsletterId, name: "Supporter", description: "Back the work", benefits: "Every issue\n\nYour name on the wall", monthly: "", quarterly: "", yearly: "120", lifetime: "400", pwyw: "", founding: "on", foundingCap: "50" };
		assert.deepEqual(await as(user, () => m.payments.saveTier(null, form(fields))), { ok: true });
		const [tier] = (await api(user, "GET", `/newsletters/${user.slug}/tiers`)).body.tiers;
		assert.deepEqual([tier.name, tier.benefits, tier.yearlyCents, tier.lifetimeCents, tier.founding.enabled, tier.founding.cap], ["Supporter", ["Every issue", "Your name on the wall"], 12000, 40000, true, 50]);

		const page = await render(user, m.paymentsPage, { searchParams: Promise.resolve({}) });
		assert.match(page, /value="Supporter"/);
		assert.match(page, /Add a paid tier/);

		const changed = { ...fields, tierId: tier.id, yearly: "100", archived: "on" };
		assert.deepEqual(await as(user, () => m.payments.saveTier(null, form(changed))), { ok: true });
		const [after] = (await api(user, "GET", `/newsletters/${user.slug}/tiers`)).body.tiers;
		assert.deepEqual([after.yearlyCents, after.archived, after.founding.cap], [10000, true, 50]);

		const priceError = { error: "Enter prices of 1 or more, like 8 or 8.50, or leave a plan empty" };
		assert.deepEqual(await as(user, () => m.payments.saveTier(null, form({ ...fields, name: "Other", yearly: "x" }))), priceError);
		assert.deepEqual(await as(user, () => m.payments.saveTier(null, form({ ...fields, name: "Free", yearly: "", lifetime: "" }))).then(({ error }) => typeof error), "string", "a tier with no price");

		await as(user, () => m.payments.saveTier(null, form({ ...fields, name: "Patron", yearly: "300", lifetime: "", founding: "" })));
		const ids = (await api(user, "GET", `/newsletters/${user.slug}/tiers`)).body.tiers.map(({ id }) => id);
		assert.deepEqual(await as(user, () => m.payments.moveTier(user.newsletterId, [...ids].reverse())), { ok: true });
		assert.deepEqual((await api(user, "GET", `/newsletters/${user.slug}/tiers`)).body.tiers.map(({ id }) => id), [...ids].reverse());
		assert.deepEqual(await as(user, () => m.payments.deleteTier(user.newsletterId, ids[1])), { ok: true });
		assert.equal((await api(user, "GET", `/newsletters/${user.slug}/tiers`)).body.tiers.length, 1);
	});
});

describe("the send step's audience", () => {
	test("is chosen on the campaign page and goes to paid readers only", async () => {
		const user = await seller();
		await as(user, () => m.payments.savePaidTier(null, form({ newsletterId: user.newsletterId, enabled: "on", monthly: "8", yearly: "", currency: "usd", trialDays: "0", pitch: "" })));
		const paidUntil = new Date(Date.now() + 20 * 86_400_000);
		await m.Contact.create({ accountId: user.accountId, newsletterId: user.newsletterId, email: "paid@example.net", status: "active", tier: "paid", paidUntil });
		await m.Contact.create({ accountId: user.accountId, newsletterId: user.newsletterId, email: "free@example.net", status: "active" });
		const url = await as(user, () => catchRedirect(m.campaigns.createCampaign(user.newsletterId)));
		const id = url.split("/").at(-1);
		await as(user, () => m.campaigns.saveCampaign(id, { subject: "Dashboard issue", previewText: "Hi", body: "<p>Hello paid readers</p>" }));

		const markup = await render(user, m.campaignPage, { params: Promise.resolve({ id }) });
		assert.match(markup, /Audience/);
		assert.match(markup, /Paid readers/);

		assert.deepEqual(await as(user, () => m.campaigns.setCampaignAudience(id, "paid")), { ok: true });
		assert.equal((await api(user, "GET", `/campaigns/${id}`)).body.audience, "paid");
		const before = emails.length;
		assert.deepEqual(await as(user, () => m.campaigns.sendCampaign(id, { audience: "paid" })), { ok: true });
		for (const job of published.filter(({ url: target }) => target.endsWith("/api/jobs/send-batch"))) {
			const route = await import("../app/api/jobs/send-batch/route.js");
			await route.POST(new Request(job.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(job.body) }));
		}
		assert.deepEqual(emails.slice(before).map(({ to }) => to), ["paid@example.net"]);

		const report = await render(user, m.campaignPage, { params: Promise.resolve({ id }) });
		assert.match(report, /Paid subscribers/, "the report says who it went to");
	});

	test("hides the choice while the newsletter has no paid tier", async () => {
		const user = await seller();
		await m.Contact.create({ accountId: user.accountId, newsletterId: user.newsletterId, email: "reader@example.net", status: "active" });
		const url = await as(user, () => catchRedirect(m.campaigns.createCampaign(user.newsletterId)));
		const markup = await render(user, m.campaignPage, { params: Promise.resolve({ id: url.split("/").at(-1) }) });
		assert.doesNotMatch(markup, /Paid readers/);
		assert.match((await as(user, () => m.campaigns.setCampaignAudience(url.split("/").at(-1), "paid"))).error, /paid tier/);
	});
});
