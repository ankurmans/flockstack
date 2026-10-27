import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { as, anonymous } from "./helpers/app.mjs";
import { setupAudienceTests } from "./helpers/audience.mjs";
import { setAi } from "./stubs/opennext-cloudflare.mjs";
let t, m, owner, newsletter, contact, reader, calls;
before(async () => {
	t = await setupAudienceTests();
	owner = await t.customer("translation-owner@example.com");
	m = { Newsletter: (await import("../models/Newsletter.js")).default, Contact: (await import("../models/Contact.js")).default, Campaign: (await import("../models/Campaign.js")).default, Cache: (await import("../models/IssueTranslation.js")).default, Usage: (await import("../models/AiUsage.js")).default, route: await import("../app/api/reader-translation/route.js"), session: await import("../lib/reader-session.js") };
	await m.Newsletter.updateOne({ accountId: owner.accountId, _id: owner.newsletterId }, { $set: { archiveEnabled: true, readerTranslations: true } });
	newsletter = await m.Newsletter.findOne({ accountId: owner.accountId, _id: owner.newsletterId }).lean();
	contact = await m.Contact.create({ accountId: owner.accountId, newsletterId: owner.newsletterId, email: "private-reader@example.com", status: "active" });
	reader = { jar: new Map(), ip: "198.51.100.99" };
	await as(reader, () => m.session.startReaderSession(newsletter, contact._id));
});
afterEach(() => setAi(null));
after(() => t?.app.stop());
async function issue(slug, extra = {}) { return m.Campaign.create({ accountId: owner.accountId, newsletterId: owner.newsletterId, subject: "Field notes", status: "sent", archiveSlug: slug, format: "rich", html: "<p>Public text for the reader.</p>", ...extra }); }
function model(answer) {
	calls = [];
	setAi({ async run(model, input, options) { calls.push({ model, input, options }); return answer ? answer({ model, input, options }) : { response: `${JSON.parse(input.messages[1].content)}\n[END_TRANSLATION]` }; } });
}
async function post(slug, who = reader, { origin = "http://localhost:3000", language = "es" } = {}) {
	const request = new Request("http://localhost:3000/api/reader-translation", { method: "POST", headers: { "content-type": "application/json", ...(origin && { origin }) }, body: JSON.stringify({ slug: owner.slug, post: slug, language }) });
	const response = await (who ? as(who, () => m.route.POST(request)) : anonymous(() => m.route.POST(request)));
	return { status: response.status, headers: response.headers, body: await response.json() };
}
test("translation requires a signed-in reader and same-origin request, and does not accept owner credentials instead", async () => {
	await issue("permission-boundary"); model();
	assert.equal((await post("permission-boundary", null)).status, 401);
	assert.equal((await post("permission-boundary", owner)).status, 401);
	assert.equal((await post("permission-boundary", reader, { origin: "https://elsewhere.example.com" })).status, 403);
	assert.equal((await post("permission-boundary", reader, { language: "xx" })).status, 400);
	assert.equal(calls.length, 0);
});
test("translates only the reader's visible text, stores no reader identity and shares the unchanged source cache", async () => {
	await issue("paywall-boundary", { html: '<p>Public beginning.</p><div data-paywall></div><p>ONLY_PAID_REMAINDER</p>' }); model();
	const first = await post("paywall-boundary"); assert.equal(first.status, 200); assert.equal(first.body.cached, false);
	assert.doesNotMatch(first.body.text, /ONLY_PAID/);
	assert.equal(first.headers.get("cache-control"), "private, no-store");
	assert.equal((await post("paywall-boundary")).body.cached, true); assert.equal(calls.length, 1);
	const sent = JSON.stringify(calls[0].input); assert.doesNotMatch(sent, /private-reader|example.com|contactId|accountId/);
	assert.deepEqual(calls[0].options.gateway, { id: "default", collectLog: false, skipCache: true });
	const cached = await m.Cache.findOne({ accountId: owner.accountId, language: "es" }).lean(); assert.equal(cached.contactId, undefined); assert.equal(cached.email, undefined);
	await m.Contact.updateOne({ accountId: owner.accountId, _id: contact._id }, { $set: { tier: "paid", paidUntil: new Date("2090-01-01") } });
	assert.match((await post("paywall-boundary")).body.text, /ONLY_PAID_REMAINDER/); assert.equal(calls.length, 2);
	await m.Contact.updateOne({ accountId: owner.accountId, _id: contact._id }, { $set: { tier: "free" } });
	assert.doesNotMatch((await post("paywall-boundary")).body.text, /ONLY_PAID/);
});
test("a changed source invalidates its translation and HTML paywall breaks cannot leak", async () => {
	const campaign = await issue("changed-source", { format: "html", html: '<p>First text.</p><div data-paywall></div><p>PRIVATE_HTML_PART</p>' }); model();
	assert.doesNotMatch((await post("changed-source")).body.text, /PRIVATE_HTML_PART/);
	await m.Campaign.updateOne({ accountId: owner.accountId, _id: campaign._id }, { $set: { html: "<p>Edited text.</p>" } });
	const next = await post("changed-source"); assert.equal(next.body.cached, false); assert.match(next.body.text, /Edited text/);
	assert.equal(calls.length, 2);
});
test("failure and incomplete model output refund quota, and long issues are never silently clipped", async () => {
	await issue("incomplete-output"); model(() => ({ response: "Incomplete answer" }));
	const before = await m.Usage.findOne({ accountId: owner.accountId }).lean();
	assert.equal((await post("incomplete-output")).status, 503);
	assert.equal((await m.Usage.findOne({ accountId: owner.accountId }).lean()).count, before.count);
	await issue("long-source", { html: `<p>${"Long source ".repeat(1200)}</p>` }); calls = [];
	assert.equal((await post("long-source")).status, 422); assert.equal(calls.length, 0);
});
test("revoked access during inference cannot receive or populate a translated body", async () => {
	await issue("revoked-during-model");
	model(async () => { await m.Contact.updateOne({ accountId: owner.accountId, _id: contact._id }, { $set: { status: "unsubscribed" } }); return { response: "No longer authorized\n[END_TRANSLATION]" }; });
	assert.equal((await post("revoked-during-model")).status, 401);
	assert.equal(await m.Cache.countDocuments({ accountId: owner.accountId, text: "No longer authorized" }), 0);
	await m.Contact.updateOne({ accountId: owner.accountId, _id: contact._id }, { $set: { status: "active" } });
});
test("enabling translation needs a model binding, is off by default and remains a registered setting", async () => {
	const disabled = await t.api(owner.key, "PATCH", "/reader-settings", { newsletter: owner.newsletterId, readerTranslations: true }); assert.equal(disabled.status, 409);
	model();
	const enabled = await t.api(owner.key, "PATCH", "/reader-settings", { newsletter: owner.newsletterId, readerTranslations: true }); assert.equal(enabled.status, 200); assert.equal(enabled.body.readerTranslations, true);
	await t.api(owner.key, "PATCH", "/reader-settings", { newsletter: owner.newsletterId, readerTranslations: false });
	assert.equal((await post("changed-source")).status, 403);
});
async function freshReader() {
	await m.Newsletter.updateOne({ accountId: owner.accountId, _id: owner.newsletterId }, { $set: { readerTranslations: true } });
	const record = await m.Contact.create({ accountId: owner.accountId, newsletterId: owner.newsletterId, email: `reader-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`, status: "active" });
	const browser = { jar: new Map(), ip: "198.51.100.100" };
	await as(browser, () => m.session.startReaderSession(newsletter, record._id));
	return { browser, record };
}
test("an in-flight translation uses one model call and one allowance unit, then expired caches regenerate", async () => {
	const { browser } = await freshReader(); const campaign = await issue("lease-and-expiry");
	let release; const waiting = new Promise((resolve) => { release = resolve; });
	let entered; const started = new Promise((resolve) => { entered = resolve; });
	model(async () => { entered(); await waiting; return { response: "Texto completo\n[END_TRANSLATION]" }; });
	const first = post("lease-and-expiry", browser); await started;
	try { assert.equal((await post("lease-and-expiry", browser)).status, 202); assert.equal(calls.length, 1); }
	finally { release(); }
	assert.equal((await first).status, 200);
	assert.equal((await post("lease-and-expiry", browser)).body.cached, true);
	await m.Cache.updateMany({ accountId: owner.accountId, campaignId: campaign._id }, { $set: { expiresAt: new Date(0) } });
	assert.equal((await post("lease-and-expiry", browser)).body.cached, false); assert.equal(calls.length, 2);
});
test("a source edit or disabled setting during inference discards the output and refunds its allowance", async () => {
	const { browser } = await freshReader(); const campaign = await issue("edited-during-model");
	const count = (await m.Usage.findOne({ accountId: owner.accountId }).lean()).count;
	model(async () => { await m.Campaign.updateOne({ accountId: owner.accountId, _id: campaign._id }, { $set: { subject: "New title" } }); return { response: "Old translation\n[END_TRANSLATION]" }; });
	assert.equal((await post("edited-during-model", browser)).status, 409);
	model(async () => { await m.Newsletter.updateOne({ accountId: owner.accountId, _id: owner.newsletterId }, { $set: { readerTranslations: false } }); return { response: "Disabled translation\n[END_TRANSLATION]" }; });
	assert.equal((await post("edited-during-model", browser)).status, 403);
	assert.equal((await m.Usage.findOne({ accountId: owner.accountId }).lean()).count, count);
	assert.equal(await m.Cache.countDocuments({ accountId: owner.accountId, text: { $in: ["Old translation", "Disabled translation"] } }), 0);
});
test("daily quota refuses inference, while a different publication's reader cannot use this session", async () => {
	const { browser } = await freshReader(); await issue("quota-limited"); model();
	const account = await (await import("../models/Account.js")).default.findById(owner.accountId).lean();
	const limit = (await import("../lib/plans.js")).getAiDailyLimit(account);
	assert.ok(Number.isInteger(limit));
	const day = (await import("../lib/ai-usage.js")).getUsageDay();
	await m.Usage.updateOne({ accountId: owner.accountId, day }, { $set: { count: limit } }, { upsert: true });
	assert.equal((await post("quota-limited", browser)).status, 429); assert.equal(calls.length, 0);
	assert.equal((await m.Usage.findOne({ accountId: owner.accountId, day }).lean()).count, limit);
	await m.Usage.updateOne({ accountId: owner.accountId, day }, { $set: { count: 0 } });
	const other = await t.customer("other-translation-owner@example.com");
	const wrongBrowser = { jar: new Map(), ip: "198.51.100.101" };
	const otherNewsletter = await m.Newsletter.findOne({ accountId: other.accountId, _id: other.newsletterId }).lean();
	const otherContact = await m.Contact.create({ accountId: other.accountId, newsletterId: other.newsletterId, email: "other-reader@example.com", status: "active" });
	await as(wrongBrowser, () => m.session.startReaderSession(otherNewsletter, otherContact._id));
	assert.equal((await post("quota-limited", wrongBrowser)).status, 401); assert.equal(calls.length, 0);
});
test("a paid subscriber outside an issue's tier receives only its teaser, and drafts and email-only issues are refused", async () => {
	const { browser, record } = await freshReader();
	await m.Contact.updateOne({ accountId: owner.accountId, _id: record._id }, { $set: { tier: "paid", paidTierId: "basic", paidUntil: new Date("2090-01-01") } });
	await issue("restricted-tier", { audience: "paid", audienceTiers: ["premium"], html: `<p>${"Opening words. ".repeat(150)}</p><p>PREMIUM_ONLY_END</p>` }); model();
	assert.doesNotMatch((await post("restricted-tier", browser)).body.text, /PREMIUM_ONLY_END/);
	await m.Contact.updateOne({ accountId: owner.accountId, _id: record._id }, { $set: { paidTierId: "premium" } });
	assert.match((await post("restricted-tier", browser)).body.text, /PREMIUM_ONLY_END/);
	await issue("not-published", { status: "draft" }); await issue("email-only", { publishTo: "email" });
	assert.equal((await post("not-published", browser)).status, 404); assert.equal((await post("email-only", browser)).status, 404);
});
test("the proxy admits the session-bound translation route on the app and publication hosts", async () => {
	const { proxy } = await import("../proxy.js"); const { NextRequest } = await import("next/server");
	const { getSharedDomain } = await import("../lib/config.js");
	for (const host of ["localhost:3000", `${owner.slug}.${getSharedDomain()}`]) {
		const request = new NextRequest(`http://${host}/api/reader-translation`, { method: "POST", headers: { host } });
		const response = await anonymous(() => proxy(request));
		assert.equal(response.headers.get("x-middleware-next"), "1", host); assert.equal(response.headers.get("location"), null);
	}
});
test("expired translation text is cleaned up and the model participates in complete account deletion", async () => {
	const campaign = await issue("expired-cleanup");
	await m.Cache.create({ accountId: owner.accountId, newsletterId: owner.newsletterId, campaignId: campaign._id, language: "fr", sourceHash: "expired-synthetic", text: "EXPIRED_TEXT", expiresAt: new Date(0) });
	await (await import("../lib/agent-housekeeping.js")).runAgentHousekeeping();
	assert.equal(await m.Cache.countDocuments({ accountId: owner.accountId, sourceHash: "expired-synthetic" }), 0);
	assert.ok((await import("../lib/account-purge.js")).CONTENT_MODELS.includes(m.Cache));
});
