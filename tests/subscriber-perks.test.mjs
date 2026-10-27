import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { as, anonymous } from "./helpers/app.mjs";
import { setupAudienceTests } from "./helpers/audience.mjs";
import { files } from "./stubs/opennext-cloudflare.mjs";
let t, m, owner, other, newsletter, product, perk, reader, contact, route;
before(async () => {
	t = await setupAudienceTests(); m = t.m; owner = await t.customer("perk-owner@example.com"); other = await t.customer("other-perk-owner@example.com");
	await m.Newsletter.updateOne({ accountId: owner.accountId, _id: owner.newsletterId }, { $set: { archiveEnabled: true } });
	newsletter = await m.Newsletter.findOne({ accountId: owner.accountId, _id: owner.newsletterId }).lean();
	const Product = (await import("../models/Product.js")).default;
	product = await Product.create({ accountId: owner.accountId, newsletterId: owner.newsletterId, title: "Private guide", slug: "private-guide", priceCents: 1000, file: { key: "accounts/synthetic/perk-guide", name: "guide.pdf", bytes: 8, contentType: "application/pdf" } });
	files.set(product.file.key, { bytes: new TextEncoder().encode("PRIVATE_FILE"), contentType: "application/pdf" });
	contact = await m.Contact.create({ accountId: owner.accountId, newsletterId: owner.newsletterId, email: "paid-perk-reader@example.com", status: "active", tier: "paid", paidUntil: new Date("2090-01-01") });
	reader = { jar: new Map(), ip: "198.51.100.123" }; await as(reader, () => import("../lib/reader-session.js").then((session) => session.startReaderSession(newsletter, contact._id)));
	route = await import("../app/api/reader-perks/[slug]/[perk]/route.js");
});
after(() => t?.app.stop());
async function download(who = reader) { const call = () => route.GET(new Request("http://localhost:3000/download"), { params: Promise.resolve({ slug: owner.slug, perk: perk.id }) }); return who ? as(who, call) : anonymous(call); }
test("perks reference only this newsletter's private files and remain account scoped", async () => {
	const result = await t.api(owner.key, "POST", "/perks", { newsletter: owner.newsletterId, title: "Reader guide", code: "SYNTHETIC_CODE", productId: String(product._id) }); assert.equal(result.status, 200, JSON.stringify(result.body)); perk = result.body.perks[0];
	assert.equal((await t.api(other.key, "GET", `/perks?newsletter=${owner.newsletterId}`)).status, 404);
	assert.equal((await t.api(other.key, "POST", "/perks", { newsletter: other.newsletterId, title: "Wrong file", productId: String(product._id) })).status, 400);
	const current = await m.Newsletter.findOne({ accountId: owner.accountId, _id: owner.newsletterId }).lean();
	const { readerPerks } = await import("../lib/perk-rules.js"); assert.equal(readerPerks(current, contact)[0].code, "SYNTHETIC_CODE"); assert.deepEqual(readerPerks(current, { ...contact, tier: "free" }), []);
});
test("every download requires current reader entitlement and returns private attachment headers", async () => {
	assert.equal((await download(null)).status, 404); assert.equal((await download(owner)).status, 404);
	let response = await download(); assert.equal(response.status, 200); assert.equal(await response.text(), "PRIVATE_FILE"); assert.equal(response.headers.get("cache-control"), "private, no-store"); assert.equal(response.headers.get("vary"), "Cookie"); assert.match(response.headers.get("content-disposition"), /attachment/);
	await m.Contact.updateOne({ accountId: owner.accountId, _id: contact._id }, { $set: { status: "unsubscribed" } }); assert.equal((await download()).status, 404);
	await m.Contact.updateOne({ accountId: owner.accountId, _id: contact._id }, { $set: { status: "active", tier: "free" } }); assert.equal((await download()).status, 404);
	await m.Contact.updateOne({ accountId: owner.accountId, _id: contact._id }, { $set: { tier: "paid" } });
	assert.equal((await t.api(owner.key, "POST", "/perks", { newsletter: owner.newsletterId, ...perk, archived: true })).status, 200); assert.equal((await download()).status, 404);
});
test("a paid welcome lists only entitled active perks and does not expose perk codes or files", async () => {
	const { withWelcomePerks } = await import("../lib/perk-welcome.js");
	const publication = { ...newsletter, perks: [{ ...perk, archived: false }, { ...perk, id: "hidden", title: "HIDDEN_PERK", archived: true }] };
	const content = { format: "markdown", subject: "Welcome", markdown: "Authored welcome" };
	const result = withWelcomePerks(content, publication, contact); assert.match(result.markdown, /Reader guide/); assert.match(result.markdown, /\/perks/); assert.doesNotMatch(result.markdown, /HIDDEN_PERK|SYNTHETIC_CODE|accounts\/synthetic/); assert.deepEqual(withWelcomePerks(content, publication, { ...contact, tier: "free" }), content);
});
test("tier-specific perks exclude lower tiers and cannot turn an unknown minimum tier into all-paid access", async () => {
	const { canReadPerk } = await import("../lib/perk-rules.js");
	const publication = { paidTiers: [{ id: "basic", name: "Basic" }, { id: "premium", name: "Premium" }] };
	const benefit = { archived: false, tierId: "premium" };
	const active = { status: "active", tier: "paid", paidUntil: new Date("2090-01-01") };
	assert.equal(canReadPerk(publication, { ...active, paidTierId: "basic" }, benefit), false);
	assert.equal(canReadPerk(publication, { ...active, paidTierId: "premium" }, benefit), true);
	assert.equal(canReadPerk(publication, active, { ...benefit, tierId: "removed" }), false);
});
test("the shared archive projection contains no private perks, and the session page excludes them for a free reader", async () => {
	await t.api(owner.key, "POST", "/perks", { newsletter: owner.newsletterId, ...perk, archived: false });
	await m.Campaign.create({ accountId: owner.accountId, newsletterId: owner.newsletterId, status: "sent", subject: "First issue", archiveSlug: "first-issue", sentAt: new Date() });
	const { getArchiveNewsletter } = await import("../lib/archive-data.js"); assert.equal((await getArchiveNewsletter(owner.slug)).perks, undefined);
	const { renderToStaticMarkup } = await import("react-dom/server"); const page = (await import("../app/archive/[slug]/perks/page.js")).default;
	const render = () => as(reader, async () => renderToStaticMarkup(await page({ params: Promise.resolve({ slug: owner.slug }) })));
	assert.match(await render(), /SYNTHETIC_CODE/);
	await m.Contact.updateOne({ accountId: owner.accountId, _id: contact._id }, { $set: { tier: "free" } });
	assert.doesNotMatch(await render(), /SYNTHETIC_CODE|Reader guide/);
	await m.Contact.updateOne({ accountId: owner.accountId, _id: contact._id }, { $set: { tier: "paid" } });
});
