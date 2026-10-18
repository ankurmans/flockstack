import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { anonymous, as, catchNotFound, startTestApp } from "./helpers/app.mjs";
import { PRODUCT_FILE, WEBHOOK_SECRET, api, assertError, buy, createProduct, createSeller, installFakeStripe, payForSession, postPaymentEvent } from "./helpers/shop.mjs";
import { flushAfter } from "./stubs/next-server.mjs";
import { files } from "./stubs/opennext-cloudflare.mjs";
import { sent as emails } from "./stubs/ses.mjs";

// Digital products: a creator makes one, uploads its file to a private bucket and puts it on sale; a reader pays through
// Stripe Checkout on the creator's own Stripe account; the webhook fulfills the order and emails a signed download link;
// a refund stops the link.
let app;
let m;
let fake;
let seller;

const unique = (() => {
	let count = 0;
	return (prefix) => `${prefix}${++count}`;
})();

// A reader's visit to a page of the shop, as markup.
async function render(page, params) {
	const element = await anonymous(() => page(params));
	return renderToStaticMarkup(createElement("div", null, element));
}

const shopParams = (slug, product) => ({ params: Promise.resolve({ slug, ...(product && { product }) }) });

async function newSeller(prefix = "seller", options) {
	return createSeller(`${unique(prefix)}@example.com`, { fake, ...options });
}

function downloadUrlOf(email) {
	const url = /https?:\/\/[^\s"<>]+\/api\/shop\/download\?token=[A-Za-z0-9_.-]+/.exec(email.html)?.[0];
	assert.ok(url, "the email carries a download link");
	return url;
}

function download(url) {
	return anonymous(() => m.downloadRoute.GET(new Request(url)));
}

before(async () => {
	app = await startTestApp({ STRIPE_PAYMENTS_WEBHOOK_SECRET: WEBHOOK_SECRET, QSTASH_CURRENT_SIGNING_KEY: "sig-current", QSTASH_NEXT_SIGNING_KEY: "sig-next" });
	m = {
		downloadRoute: await import("../app/api/shop/download/route.js"),
		shopPage: (await import("../app/archive/[slug]/shop/page.js")).default,
		productPage: (await import("../app/archive/[slug]/shop/[product]/page.js")).default,
		productFiles: await import("../app/api/product-files/route.js"),
		sitemapRoute: await import("../app/archive/[slug]/sitemap/route.js"),
		links: await import("../lib/download-link.js"),
		proxy: (await import("../proxy.js")).proxy,
		NextRequest: (await import("next/server")).NextRequest,
		Account: (await import("../models/Account.js")).default,
		Buyer: (await import("../models/Buyer.js")).default,
		Contact: (await import("../models/Contact.js")).default,
		Message: (await import("../models/Message.js")).default,
		Order: (await import("../models/Order.js")).default,
		Product: (await import("../models/Product.js")).default,
		Suppression: (await import("../models/Suppression.js")).default,
	};
});

after(() => app?.stop());

beforeEach(() => {
	fake = installFakeStripe();
});

describe("a product's life", () => {
	test("is made as a draft, gets its file, goes on sale, changes, is archived and comes back", async () => {
		seller = await newSeller();
		const created = await api(seller, "POST", "/products", { title: "Launch checklist", description: "Everything before issue one.", priceCents: 1900 });
		assert.equal(created.status, 201);
		assert.deepEqual(
			{ status: created.body.status, slug: created.body.slug, currency: created.body.currency, file: created.body.file, url: created.body.url, sales: created.body.sales },
			{ status: "draft", slug: "launch-checklist", currency: "usd", file: null, url: null, sales: 0 }
		);
		const { id } = created.body;

		assert.match(assertError(await api(seller, "PATCH", `/products/${id}`, { status: "active" }), 400, "validation_failed"), /Upload the file buyers get/);

		const uploaded = await api(seller, "POST", `/products/${id}/file`, { base64: PRODUCT_FILE.toString("base64"), fileName: "Launch Checklist.pdf", contentType: "application/pdf" });
		assert.deepEqual({ name: uploaded.body.file.name, bytes: uploaded.body.file.bytes, contentType: uploaded.body.file.contentType }, { name: "Launch Checklist.pdf", bytes: PRODUCT_FILE.length, contentType: "application/pdf" });
		const key = (await m.Product.findOne({ accountId: seller.accountId, _id: id }).lean()).file.key;
		assert.match(key, new RegExp(`^accounts/${seller.accountId}/products/${id}/[0-9a-f-]{36}-Launch-Checklist\\.pdf$`));
		assert.deepEqual(files.get(key).bytes, new Uint8Array(PRODUCT_FILE), "the bytes are in the private bucket");
		assert.doesNotMatch(JSON.stringify(uploaded.body), new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the key never reaches a caller");

		const active = await api(seller, "PATCH", `/products/${id}`, { status: "active", priceCents: 2400 });
		assert.deepEqual([active.body.status, active.body.priceCents, active.body.url], ["active", 2400, `https://${seller.slug}.flockstackmail.com/shop/launch-checklist`]);

		assert.equal((await api(seller, "GET", "/products?status=active")).body.products.length, 1);
		assert.equal((await api(seller, "GET", "/products?status=draft")).body.products.length, 0);
		assert.equal((await api(seller, "GET", `/products/${id}`)).body.title, "Launch checklist");

		const archived = await api(seller, "POST", `/products/${id}/archive`);
		assert.equal(archived.body.status, "archived");
		assert.equal(archived.body.url, null);
		assert.equal((await api(seller, "POST", `/products/${id}/archive`)).status, 200, "safe to repeat");
		assert.match(assertError(await api(seller, "PATCH", `/products/${id}`, { status: "active" }), 409, "conflict"), /archived/);
		const back = await api(seller, "PATCH", `/products/${id}`, { status: "draft" });
		assert.equal(back.body.status, "draft");
		assert.equal((await api(seller, "PATCH", `/products/${id}`, { status: "active" })).body.status, "active");
	});

	test("checks its title, price, currency and slug", async () => {
		seller = await newSeller();
		assertError(await api(seller, "POST", "/products", { title: "", priceCents: 1900 }), 400, "validation_failed");
		assertError(await api(seller, "POST", "/products", { title: "Cheap", priceCents: 5 }), 400, "validation_failed");
		assertError(await api(seller, "POST", "/products", { title: "Odd", priceCents: 1900, currency: "xxx" }), 400, "validation_failed");
		assertError(await api(seller, "POST", "/products", { title: "Odd", priceCents: 19.5 }), 400, "validation_failed");
		const first = await api(seller, "POST", "/products", { title: "Guide", priceCents: 900 });
		const second = await api(seller, "POST", "/products", { title: "Guide", priceCents: 900 });
		assert.deepEqual([first.body.slug, second.body.slug], ["guide", "guide-2"], "a taken slug gets a number");
		assertError(await api(seller, "POST", "/products", { title: "Guide again", priceCents: 900, slug: "guide" }), 409, "conflict");
		assertError(await api(seller, "PATCH", `/products/${second.body.id}`, { slug: "guide" }), 409, "conflict");
		assert.equal((await api(seller, "PATCH", `/products/${second.body.id}`, { slug: "guide-pro", currency: "eur" })).body.currency, "eur");
		assertError(await api(seller, "POST", `/products/${first.body.id}/file`, { base64: "!!!", fileName: "x.pdf" }), 400, "validation_failed");
	});

	test("goes on sale only where the account can take payments", async () => {
		seller = await newSeller("unconnected", { ready: false });
		const draft = await createProduct(seller, {}, { activate: false });
		assert.match(assertError(await api(seller, "PATCH", `/products/${draft.id}`, { status: "active" }), 409, "payments_not_ready"), /Connect your Stripe account/);
		await m.Account.updateOne({ _id: seller.accountId }, { $set: { "payments.stripeAccountId": "acct_half", "payments.chargesEnabled": false } });
		assert.match(assertError(await api(seller, "PATCH", `/products/${draft.id}`, { status: "active" }), 409, "payments_not_ready"), /Finish setting up/);
	});

	test("one account's products are invisible to another", async () => {
		seller = await newSeller();
		const stranger = await newSeller("stranger");
		const product = await createProduct(seller);
		for (const [method, path, body] of [
			["GET", `/products/${product.id}`],
			["PATCH", `/products/${product.id}`, { title: "Hacked" }],
			["POST", `/products/${product.id}/archive`],
			["POST", `/products/${product.id}/file`, { base64: "AAAA", fileName: "x.bin" }],
		]) {
			assertError(await api(stranger, method, path, body), 404, "not_found");
		}
		assert.deepEqual((await api(stranger, "GET", "/products")).body.products, []);
		assert.equal((await m.Product.findOne({ accountId: seller.accountId, _id: product.id }).lean()).title, "Launch checklist");
	});

	test("the dashboard's upload route stores the file through the same action", async () => {
		seller = await newSeller();
		const product = await createProduct(seller, {}, { file: null, activate: false });
		const request = new Request("http://localhost:3000/api/product-files", {
			method: "POST",
			headers: { "x-product-id": product.id, "x-file-name": encodeURIComponent("Guide v2.zip"), "content-type": "application/zip", "sec-fetch-site": "same-origin" },
			body: PRODUCT_FILE,
		});
		const response = await as(seller, () => m.productFiles.POST(request));
		assert.equal(response.status, 200);
		assert.equal((await response.json()).product.file.name, "Guide v2.zip");
		const cross = new Request("http://localhost:3000/api/product-files", { method: "POST", headers: { "x-product-id": product.id, "sec-fetch-site": "cross-site" }, body: PRODUCT_FILE });
		assert.equal((await as(seller, () => m.productFiles.POST(cross))).status, 403);
		assert.equal((await anonymous(() => m.productFiles.POST(new Request("http://localhost:3000/api/product-files", { method: "POST", body: PRODUCT_FILE })))).status, 401);
	});
});

describe("the shop on the newsletter's site", () => {
	test("lists products on sale and gives each a page with its buy form, and nothing else", async () => {
		seller = await newSeller();
		const onSale = await createProduct(seller, { title: "Template pack", description: "Forty email templates." });
		await createProduct(seller, { title: "Hidden draft" }, { activate: false });
		const archived = await createProduct(seller, { title: "Old guide" });
		await api(seller, "POST", `/products/${archived.id}/archive`);

		const shop = await render(m.shopPage, shopParams(seller.slug));
		assert.match(shop, /Template pack/);
		assert.match(shop, /\$19\.00/);
		assert.doesNotMatch(shop, /Hidden draft|Old guide/);

		const page = await render(m.productPage, shopParams(seller.slug, onSale.slug));
		assert.match(page, /Template pack/);
		assert.match(page, /Forty email templates/);
		assert.match(page, /Buy for \$19\.00/);
		assert.match(page, /Also send me the newsletter, free/);
		assert.doesNotMatch(page, /accounts\/|\/products\//, "no file key reaches the page");

		for (const slug of ["hidden-draft", "old-guide", "missing"]) {
			assert.equal(await catchNotFound(m.productPage(shopParams(seller.slug, slug))), true, slug);
		}
	});

	test("is off while the account can't take payments, and a newsletter with nothing on sale has no shop", async () => {
		seller = await newSeller("emptyshop");
		assert.equal(await catchNotFound(m.shopPage(shopParams(seller.slug))), true, "nothing on sale");
		const product = await createProduct(seller);
		assert.match(await render(m.shopPage, shopParams(seller.slug)), /Launch checklist/);
		await m.Account.updateOne({ _id: seller.accountId }, { $set: { "payments.chargesEnabled": false } });
		assert.equal(await catchNotFound(m.shopPage(shopParams(seller.slug))), true, "payments off");
		assert.match(await render(m.productPage, shopParams(seller.slug, product.slug)), /can(?:'|&#x27;)t be bought right now/);
		assert.doesNotMatch(await render(m.productPage, shopParams(seller.slug, product.slug)), /Buy for/);
	});

	test("is in the website's sitemap while payments can take a sale", async () => {
		seller = await newSeller();
		const product = await createProduct(seller, { title: "Template pack" });
		const read = async () => (await m.sitemapRoute.GET(new Request(`https://${seller.slug}.flockstackmail.com/sitemap.xml`), { params: Promise.resolve({ slug: seller.slug }) })).text();
		const sitemap = await read();
		assert.match(sitemap, new RegExp(`<loc>https://${seller.slug}\\.flockstackmail\\.com/shop</loc>`));
		assert.match(sitemap, new RegExp(`<loc>https://${seller.slug}\\.flockstackmail\\.com/shop/${product.slug}</loc>`));
		await api(seller, "POST", `/products/${product.id}/archive`);
		assert.doesNotMatch(await read(), /\/shop/);
	});

	test("is served on the newsletter's own host", async () => {
		seller = await newSeller();
		const visit = (path) => m.proxy(new m.NextRequest(`https://${seller.slug}.flockstackmail.com${path}`, { headers: { host: `${seller.slug}.flockstackmail.com` } }));
		const rewritten = async (path) => new URL((await visit(path)).headers.get("x-middleware-rewrite")).pathname;
		assert.equal(await rewritten("/shop"), `/archive/${seller.slug}/shop`);
		assert.equal(await rewritten("/shop/template-pack"), `/archive/${seller.slug}/shop/template-pack`);
		assert.equal(await rewritten("/subscribe"), `/archive/${seller.slug}/subscribe`);
		assert.equal((await visit("/api/shop/download?token=x")).headers.get("x-middleware-next"), "1", "downloads open on the host");
		assert.equal((await visit("/api/shop/portal?token=x")).headers.get("x-middleware-next"), "1");
		assert.equal((await visit("/shop/../admin")).status, 404);
	});
});

describe("buying", () => {
	test("opens a Checkout Session on the creator's own Stripe account, for that product's price, with no application fee", async () => {
		seller = await newSeller();
		const product = await createProduct(seller, { title: "Template pack", priceCents: 2900, currency: "eur", description: "Forty email templates." });
		const answer = await buy(seller, product.slug, { email: "Sam@Example.net", addToList: "on" });
		assert.match(answer.url, /^https:\/\/checkout\.stripe\.test\/c\/pay\//);

		const request = fake.requests.find(({ path }) => path === "/v1/checkout/sessions");
		assert.equal(request.account, seller.stripeAccountId, "a direct charge on their account");
		assert.equal(request.authorization, "Bearer sk_test_flockstack");
		const { params } = request;
		assert.equal(params.mode, "payment");
		assert.deepEqual(params.line_items, [{ quantity: "1", price_data: { currency: "eur", unit_amount: "2900", product_data: { name: "Template pack", description: "Forty email templates." } } }]);
		assert.equal(params.customer_email, "sam@example.net");
		assert.deepEqual(params.metadata, {
			flockstack: "1",
			kind: "product",
			accountId: String(seller.accountId),
			newsletterId: String(seller.newsletterId),
			productId: product.id,
			addToList: "1",
		});
		assert.deepEqual(params.payment_intent_data.metadata, params.metadata, "the charge carries it too");
		assert.equal(params.success_url, `https://${seller.slug}.flockstackmail.com/shop/template-pack?paid=1`);
		assert.equal(params.cancel_url, `https://${seller.slug}.flockstackmail.com/shop/template-pack`);
		assert.doesNotMatch(JSON.stringify(request), /application_fee/i, "FlockStack never takes a cut");
		assert.equal(await m.Order.countDocuments({ accountId: seller.accountId }), 0, "nothing is an order until it is paid");
	});

	test("takes the price from the database, not the form, and refuses what isn't for sale", async () => {
		seller = await newSeller();
		const product = await createProduct(seller);
		await buy(seller, product.slug, { priceCents: "1", price: "0.01", unit_amount: "1" });
		const request = fake.requests.findLast(({ path }) => path === "/v1/checkout/sessions");
		assert.equal(request.params.line_items[0].price_data.unit_amount, "1900");

		const draft = await createProduct(seller, { title: "Draft one" }, { activate: false });
		assert.deepEqual(await buy(seller, draft.slug), { error: "This product isn't for sale" });
		assert.deepEqual(await buy(seller, "../other"), { error: "This product isn't for sale" });
		assert.deepEqual(await buy({ slug: "no-such-shop" }, product.slug), { error: "This shop isn't open" });
		assert.deepEqual(await buy(seller, product.slug, { email: "not an email" }), { error: "Enter a valid email" });
		assert.deepEqual(await buy(seller, product.slug, { website: "bot" }), { error: "This product isn't for sale" });
		await m.Account.updateOne({ _id: seller.accountId }, { $set: { "payments.chargesEnabled": false } });
		assert.deepEqual(await buy(seller, product.slug), { error: "Payments aren't open for this shop yet" });
	});

	test("says so when Stripe is down, and logs why", async () => {
		seller = await newSeller();
		const product = await createProduct(seller);
		fake.failNext("POST /v1/checkout/sessions");
		assert.deepEqual(await buy(seller, product.slug), { error: "Checkout isn't available right now. Try again in a minute." });
	});

	test("a self-hosted server charges with its owner's own key and sends no Stripe-Account header", async () => {
		const { withEnv } = await import("./helpers/app.mjs");
		const owner = await createSeller(`${unique("selfhosted")}@example.com`, { fake, ready: false });
		await withEnv({ FLOCKSTACK_CLOUD: "", ALLOWED_EMAILS: "@example.com" }, async () => {
			assert.equal((await m.Account.findById(owner.accountId).lean()).payments?.stripeAccountId, undefined);
			const product = await createProduct(owner, { title: "Own key product" });
			const answer = await buy(owner, product.slug);
			assert.ok(answer.url);
			const request = fake.requests.findLast(({ path }) => path === "/v1/checkout/sessions");
			assert.equal(request.account, null);
			assert.doesNotMatch(JSON.stringify(request.params), /application_fee/);
		});
	});
});

describe("a paid order", () => {
	test("is fulfilled by the webhook: an order, a buyer, and an email with a signed download link, once", async () => {
		seller = await newSeller();
		const product = await createProduct(seller, { title: "Template pack", priceCents: 2900 });
		const { url } = await buy(seller, product.slug);
		const before = emails.length;
		const { event, result } = await payForSession(fake, seller, url, { email: "Sam@Example.net", name: "Sam Buyer" });
		assert.deepEqual([result.status, result.body.handled, result.body.created], [200, "checkout.session.completed", true]);

		const order = await m.Order.findOne({ accountId: seller.accountId }).lean();
		assert.deepEqual(
			{ buyerEmail: order.buyerEmail, buyerName: order.buyerName, amountCents: order.amountCents, currency: order.currency, status: order.status, productTitle: order.productTitle, emailStatus: order.emailStatus },
			{ buyerEmail: "sam@example.net", buyerName: "Sam Buyer", amountCents: 2900, currency: "usd", status: "paid", productTitle: "Template pack", emailStatus: "sent" }
		);
		assert.equal(String(order.productId), product.id);
		assert.match(order.stripePaymentIntentId, /^pi_test_/);
		const buyer = await m.Buyer.findOne({ accountId: seller.accountId }).lean();
		assert.deepEqual([buyer.email, buyer.name, buyer.orderCount], ["sam@example.net", "Sam Buyer", 1]);

		assert.equal(emails.length - before, 1, "one email");
		const email = emails.at(-1);
		assert.equal(email.to, "sam@example.net");
		assert.equal(email.subject, "Your download: Template pack");
		assert.match(email.from, new RegExp(`hello@${seller.slug}\\.flockstackmail\\.com`));
		assert.match(email.html, /You(?:'|&#39;)re receiving this because you bought Template pack from/);
		assert.doesNotMatch(email.html, /Unsubscribe/i, "an order's email is not a newsletter");
		assert.equal(email.headers["List-Unsubscribe"], undefined);
		assert.doesNotMatch(email.html, /\/o\/|\/c\//, "not tracked");
		const link = downloadUrlOf(email);
		assert.ok(link.startsWith(`https://${seller.slug}.flockstackmail.com/api/shop/download?token=`));
		assert.ok(email.text.includes(link), "and in the plain text");
		assert.equal((await m.Message.findOne({ accountId: seller.accountId, kind: "order" }).lean()).status, "sent");

		// Stripe sends the same event again.
		const again = await postPaymentEvent(event);
		assert.deepEqual([again.status, again.body.duplicate], [200, true]);
		// The same session reported by another event id (the async payment path) finds its order too.
		const other = fake.event("checkout.session.async_payment_succeeded", event.data.object, { account: seller.stripeAccountId });
		const second = await postPaymentEvent(other);
		assert.deepEqual([second.body.handled, second.body.created], ["checkout.session.async_payment_succeeded", false]);
		assert.equal(await m.Order.countDocuments({ accountId: seller.accountId }), 1);
		assert.equal((await m.Buyer.findOne({ accountId: seller.accountId }).lean()).orderCount, 1);
		assert.equal(emails.length - before, 1, "still one email");
	});

	test("ignores sessions FlockStack didn't make, other accounts' sessions and unpaid ones", async () => {
		seller = await newSeller();
		const product = await createProduct(seller);
		const { url } = await buy(seller, product.slug);
		const session = [...fake.sessions.values()].find((candidate) => candidate.url === url);
		const send = (object) => postPaymentEvent(fake.event("checkout.session.completed", object, { account: seller.stripeAccountId }));

		assert.equal((await send({ ...session, metadata: {}, payment_status: "paid" })).body.ignored, "not a FlockStack sale", "the creator's other sales");
		assert.equal((await send({ ...session, metadata: { ...session.metadata, accountId: "6a0000000000000000000001" }, payment_status: "paid" })).body.ignored, "another account's sale");
		assert.equal((await send({ ...session, payment_status: "unpaid" })).body.ignored, "not paid yet");
		assert.equal(await m.Order.countDocuments({ accountId: seller.accountId }), 0);
	});

	test("keeps working when the email can't go out: the order is there, the creator hears and can resend", async () => {
		seller = await newSeller();
		const product = await createProduct(seller);
		await m.Suppression.create({ accountId: seller.accountId, email: "bounced@example.net", reason: "bounce" });
		const before = emails.length;
		const { url } = await buy(seller, product.slug);
		const { result } = await payForSession(fake, seller, url, { email: "bounced@example.net" });
		assert.equal(result.status, 200);
		const order = await m.Order.findOne({ accountId: seller.accountId }).lean();
		assert.deepEqual([order.emailStatus, order.emailError], ["suppressed", "suppressed"]);
		assert.equal(emails.length, before, "nothing was sent to an address that bounced");
		const orders = await api(seller, "GET", "/orders");
		assert.deepEqual([orders.body.orders[0].emailStatus, orders.body.orders[0].status], ["suppressed", "paid"]);
	});

	test("with the box ticked, the buyer joins the list as a signup form would", async () => {
		seller = await newSeller("joiner", { requireConfirmation: true });
		const product = await createProduct(seller);
		const { url } = await buy(seller, product.slug, { addToList: "on" });
		await payForSession(fake, seller, url, { email: "joiner@example.net" });
		await flushAfter();
		const contact = await m.Contact.findOne({ accountId: seller.accountId, email: "joiner@example.net" }).lean();
		assert.deepEqual([contact.status, contact.source], ["pending", "shop"], "a newsletter that confirms signups still confirms");
		assert.equal((await m.Order.findOne({ accountId: seller.accountId }).lean()).listConsent.contactId.toString(), String(contact._id));
		assert.ok(emails.some(({ to, subject }) => to === "joiner@example.net" && /confirm/i.test(subject)), "the confirmation email went out");
	});

	test("without the box ticked, the buyer isn't on the list", async () => {
		seller = await newSeller();
		const product = await createProduct(seller);
		const { url } = await buy(seller, product.slug);
		await payForSession(fake, seller, url, { email: "private@example.net" });
		assert.equal(await m.Contact.countDocuments({ accountId: seller.accountId, email: "private@example.net" }), 0);
		assert.equal((await m.Order.findOne({ accountId: seller.accountId }).lean()).listConsent?.at, undefined);
	});

	test("a buyer's second order adds to the same buyer", async () => {
		seller = await newSeller();
		const product = await createProduct(seller);
		for (let count = 0; count < 2; count++) {
			const { url } = await buy(seller, product.slug);
			await payForSession(fake, seller, url, { email: "repeat@example.net" });
		}
		assert.equal(await m.Order.countDocuments({ accountId: seller.accountId }), 2);
		assert.equal(await m.Buyer.countDocuments({ accountId: seller.accountId }), 1);
		assert.equal((await m.Buyer.findOne({ accountId: seller.accountId }).lean()).orderCount, 2);
		const stats = (await api(seller, "GET", "/products")).body.products[0];
		assert.deepEqual([stats.sales, stats.revenueCents], [2, 3800]);
	});
});

describe("the download link", () => {
	async function paidOrder(options = {}) {
		seller = await newSeller();
		const product = await createProduct(seller, { title: "Template pack" });
		const { url } = await buy(seller, product.slug);
		const { session } = await payForSession(fake, seller, url, options);
		const order = await m.Order.findOne({ accountId: seller.accountId }).lean();
		return { product, session, order, link: downloadUrlOf(emails.at(-1)) };
	}

	test("serves the file from the private bucket with download headers, and counts it", async () => {
		const { link, order } = await paidOrder();
		const response = await download(link);
		assert.equal(response.status, 200);
		assert.deepEqual(Buffer.from(await response.arrayBuffer()), PRODUCT_FILE);
		assert.equal(response.headers.get("content-type"), "application/pdf");
		assert.match(response.headers.get("content-disposition"), /^attachment; filename="launch-checklist\.pdf"/);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
		assert.equal(response.headers.get("x-content-type-options"), "nosniff");
		assert.equal((await m.Order.findOne({ accountId: seller.accountId, _id: order._id }).lean()).downloadCount, 1);
	});

	test("expires after a week", async () => {
		const { order } = await paidOrder();
		const token = await m.links.createDownloadToken({ orderId: order._id, version: 1, now: Date.now() - 8 * 86_400_000 });
		const response = await download(`http://localhost:3000/api/shop/download?token=${token}`);
		assert.equal(response.status, 410);
		assert.match(await response.text(), /expired/);
		const fresh = await m.links.createDownloadToken({ orderId: order._id, version: 1, now: Date.now() - 6 * 86_400_000 });
		assert.equal((await download(`http://localhost:3000/api/shop/download?token=${fresh}`)).status, 200, "day six still works");
	});

	test("refuses links that are forged, changed or for nothing", async () => {
		const { link, order } = await paidOrder();
		const token = new URL(link).searchParams.get("token");
		const [payload, signature] = token.split(".");
		const swapped = Buffer.from(JSON.stringify({ o: String(order._id), v: 1, e: Date.now() + 86_400_000 * 365 })).toString("base64url");
		for (const bad of ["", "x", `${swapped}.${signature}`, `${payload}.${"A".repeat(43)}`, `${payload}x.${signature}`]) {
			assert.equal((await download(`http://localhost:3000/api/shop/download?token=${bad}`)).status, 410, bad);
		}
		const missing = await m.links.createDownloadToken({ orderId: "6a0000000000000000000009" });
		assert.equal((await download(`http://localhost:3000/api/shop/download?token=${missing}`)).status, 410);
	});

	test("stops once the order is refunded in full, and a partial refund leaves it working", async () => {
		const { link, order, session } = await paidOrder();
		const charge = { id: "ch_test_1", object: "charge", payment_intent: order.stripePaymentIntentId, amount: 1900, amount_refunded: 500, refunded: false };
		const partial = await postPaymentEvent(fake.event("charge.refunded", charge, { account: seller.stripeAccountId }));
		assert.deepEqual([partial.body.handled, partial.body.revoked], ["charge.refunded", false]);
		const afterPartial = await m.Order.findOne({ accountId: seller.accountId, _id: order._id }).lean();
		assert.deepEqual([afterPartial.status, afterPartial.amountRefundedCents, afterPartial.revokedAt], ["paid", 500, undefined]);
		assert.equal((await download(link)).status, 200, "a partial refund keeps the download");

		const full = await postPaymentEvent(fake.event("charge.refunded", { ...charge, amount_refunded: 1900, refunded: true }, { account: seller.stripeAccountId }));
		assert.equal(full.body.revoked, true);
		const refunded = await m.Order.findOne({ accountId: seller.accountId, _id: order._id }).lean();
		assert.deepEqual([refunded.status, refunded.amountRefundedCents], ["refunded", 1900]);
		assert.ok(refunded.revokedAt && refunded.refundedAt);
		const response = await download(link);
		assert.equal(response.status, 410, "the link is revoked");
		assert.doesNotMatch(await response.text(), /PDF/);

		// Stripe delivers the refund event again: the order stays as it is.
		await postPaymentEvent(fake.event("charge.refunded", { ...charge, amount_refunded: 1900, refunded: true }, { account: seller.stripeAccountId }));
		assert.equal((await m.Order.findOne({ accountId: seller.accountId, _id: order._id }).lean()).status, "refunded");
		// The paid event arriving late can't bring a refunded order's link back.
		const emailsBefore = emails.length;
		await postPaymentEvent(fake.event("checkout.session.async_payment_succeeded", session, { account: seller.stripeAccountId }));
		assert.equal(emails.length, emailsBefore);
		assert.equal((await download(link)).status, 410);
		assert.match(assertError(await api(seller, "POST", `/orders/${order._id}/resend`), 409, "conflict"), /refunded/);
		assert.equal((await api(seller, "GET", `/orders/${order._id}`)).body.status, "refunded");
	});

	test("stops on a chargeback", async () => {
		const { link, order } = await paidOrder();
		const dispute = { id: "dp_test_1", object: "dispute", payment_intent: order.stripePaymentIntentId, charge: "ch_test_9" };
		assert.equal((await postPaymentEvent(fake.event("charge.dispute.created", dispute, { account: seller.stripeAccountId }))).body.revoked, true);
		assert.equal((await m.Order.findOne({ accountId: seller.accountId, _id: order._id }).lean()).status, "disputed");
		assert.equal((await download(link)).status, 410);
	});

	test("is replaced when the seller resends it, and stops after 20 downloads", async () => {
		const { link, order } = await paidOrder();
		const before = emails.length;
		const resent = await api(seller, "POST", `/orders/${order._id}/resend`);
		assert.equal(resent.status, 200);
		assert.equal(resent.body.emailStatus, "sent");
		assert.equal(emails.length - before, 1);
		const fresh = downloadUrlOf(emails.at(-1));
		assert.notEqual(fresh, link);
		assert.equal((await download(link)).status, 410, "the old link stops");
		assert.equal((await download(fresh)).status, 200);

		await m.Order.updateOne({ accountId: seller.accountId, _id: order._id }, { $set: { downloadCount: 20 } });
		const limited = await download(fresh);
		assert.equal(limited.status, 429);
		assert.match(await limited.text(), /most times/);
	});

	test("never serves another account's file", async () => {
		const { order } = await paidOrder();
		const other = await newSeller("other");
		const otherProduct = await createProduct(other, { title: "Secret" });
		// A link signed for this order downloads this order's product only.
		const token = await m.links.createDownloadToken({ orderId: order._id });
		const response = await download(`http://localhost:3000/api/shop/download?token=${token}`);
		assert.deepEqual(Buffer.from(await response.arrayBuffer()), PRODUCT_FILE);
		assert.equal(await m.Order.countDocuments({ accountId: other.accountId }), 0);
		assert.equal(otherProduct.title, "Secret");
		assertError(await api(other, "GET", `/orders/${order._id}`), 404, "not_found");
		assertError(await api(other, "POST", `/orders/${order._id}/resend`), 404, "not_found");
		assert.deepEqual((await api(other, "GET", "/orders")).body.orders, []);
	});

	test("survives the product being archived: earlier buyers keep their files", async () => {
		const { link, product } = await paidOrder();
		await api(seller, "POST", `/products/${product.id}/archive`);
		assert.equal((await download(link)).status, 200);
	});
});

describe("orders", () => {
	test("are listed newest first in pages, filtered by product and status", async () => {
		seller = await newSeller();
		const first = await createProduct(seller, { title: "First" });
		const second = await createProduct(seller, { title: "Second" });
		for (const [product, email] of [[first, "a@example.net"], [second, "b@example.net"], [first, "c@example.net"]]) {
			const { url } = await buy(seller, product.slug);
			await payForSession(fake, seller, url, { email });
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		const all = await api(seller, "GET", "/orders?limit=2");
		assert.deepEqual(all.body.orders.map(({ buyerEmail }) => buyerEmail), ["c@example.net", "b@example.net"]);
		assert.ok(all.body.nextCursor);
		const next = await api(seller, "GET", `/orders?limit=2&cursor=${all.body.nextCursor}`);
		assert.deepEqual(next.body.orders.map(({ buyerEmail }) => buyerEmail), ["a@example.net"]);
		assert.equal(next.body.nextCursor, null);
		assert.deepEqual((await api(seller, "GET", `/orders?product=${second.id}`)).body.orders.map(({ productTitle }) => productTitle), ["Second"]);
		assert.equal((await api(seller, "GET", "/orders?status=refunded")).body.orders.length, 0);
		assertError(await api(seller, "GET", "/orders?product=nope"), 400, "validation_failed");
	});
});

describe("a blocked account and an account's end", () => {
	test("a blocked account's buyers still get their order, and the email waits for the creator to resend it", async () => {
		seller = await newSeller();
		const product = await createProduct(seller);
		const { url } = await buy(seller, product.slug);
		await m.Account.updateOne({ _id: seller.accountId }, { $set: { status: "paused", pauseReason: "Review", pausedBy: "admin" } });
		const before = emails.length;
		await payForSession(fake, seller, url, { email: "blocked@example.net" });
		assert.equal(emails.length, before, "a blocked account sends nothing");
		const order = await m.Order.findOne({ accountId: seller.accountId }).lean();
		assert.equal(order.emailStatus, "failed");
		assert.match(order.emailError, /./);
		await m.Account.updateOne({ _id: seller.accountId }, { $set: { status: "active" }, $unset: { pauseReason: 1, pausedBy: 1 } });
		assert.equal((await api(seller, "POST", `/orders/${order._id}/resend`)).body.emailStatus, "sent");
		assert.equal(emails.length, before + 1);
	});

	test("starting purchases is limited for one network", async () => {
		seller = await newSeller();
		const product = await createProduct(seller);
		const results = [];
		for (let count = 0; count < 21; count++) results.push(await buy(seller, product.slug, {}, { ip: "198.51.100.250" }));
		assert.equal(results.filter(({ url }) => url).length, 20);
		assert.match(results.at(-1).error, /Too many purchases started/);
		assert.ok((await buy(seller, product.slug, {}, { ip: "198.51.100.251" })).url, "another network is fine");
	});

	test("an account's purge removes its products, orders, buyers and the files in the private bucket", async () => {
		const { runPurge } = await import("../lib/account-purge.js");
		seller = await newSeller();
		const product = await createProduct(seller);
		const { url } = await buy(seller, product.slug);
		await payForSession(fake, seller, url, { email: "gone@example.net" });
		const key = (await m.Product.findOne({ accountId: seller.accountId }).lean()).file.key;
		assert.ok(files.has(key));

		const purgeAt = new Date(Date.now() - 1000);
		await m.Account.updateOne({ _id: seller.accountId }, { $set: { subscriptionStatus: "canceled", "deletion.requestedAt": new Date(Date.now() - 86_400_000), "deletion.purgeAt": purgeAt } });
		assert.deepEqual(await runPurge({ accountId: String(seller.accountId), purgeAt: purgeAt.toISOString() }), { purged: true });
		assert.equal(files.has(key), false, "the file is gone from the bucket");
		for (const Model of [m.Product, m.Order, m.Buyer]) assert.equal(await Model.countDocuments({ accountId: seller.accountId }), 0);
	});
});

describe("payments off", () => {
	test("a webhook for a product whose seller left finds no account and does nothing", async () => {
		const event = fake.event("checkout.session.completed", { id: "cs_x", metadata: { flockstack: "1", kind: "product", accountId: "6a0000000000000000000002" }, payment_status: "paid" }, { account: "acct_nobody" });
		assert.equal((await postPaymentEvent(event)).body.ignored, "unknown account");
	});
});
