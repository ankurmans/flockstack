import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { as } from "./helpers/app.mjs";
import { setupAudienceTests } from "./helpers/audience.mjs";

// beehiiv parity M4: a link that opens one paid issue's page for whoever holds it, made by a paid reader or the owner, counted by
// browser, ended by a date or by the owner.
let t;
let m;
let owner;
let other;
let newsletter;
let paidIssue;
let secondPaidIssue;
let freeIssue;
let paidReader;
let freeReader;

const SECRET = "GIFT_SECRET_BODY";
const get = (user, path) => t.api(user.key, "GET", path);
const gifts = () => import("../lib/gift-links.js");

// A browser: its cookies, and its address for the rate limits.
let browsers = 0;
const browser = () => ({ jar: new Map(), ip: `198.51.100.${200 + ++browsers}` });
async function readerBrowser(contact) {
	const who = browser();
	const session = await import("../lib/reader-session.js");
	await as(who, () => session.startReaderSession(newsletter, contact._id));
	return who;
}
const open = (who, issue, code) => as(who, async () => (await gifts()).openGiftIssue({ slug: owner.slug, post: issue.archiveSlug, code }));
const codeOf = (url) => new URL(url).searchParams.get("gift");

before(async () => {
	t = await setupAudienceTests();
	m = t.m;
	m.GiftLink = (await import("../models/GiftLink.js")).default;
	owner = await t.customer("giftlink-owner@example.com");
	other = await t.customer("giftlink-other@example.com");
	await m.Newsletter.updateOne({ accountId: owner.accountId, _id: owner.newsletterId }, { $set: { archiveEnabled: true } });
	newsletter = await m.Newsletter.findOne({ accountId: owner.accountId, _id: owner.newsletterId }).lean();
	const issue = (name, extra) => m.Campaign.create({ accountId: owner.accountId, newsletterId: owner.newsletterId, subject: name, archiveSlug: `${name}-${owner.slug}`, status: "sent", publishTo: "both", format: "rich", html: `<p>Opening</p><p>${SECRET}_${name}</p>`, sentAt: new Date(), ...extra });
	[paidIssue, secondPaidIssue, freeIssue] = [await issue("paid-one", { audience: "paid" }), await issue("paid-two", { audience: "paid" }), await issue("free-one", { audience: "all" })];
	paidReader = await m.Contact.create({ accountId: owner.accountId, newsletterId: owner.newsletterId, email: "paying@example.com", status: "active", tier: "paid", paidUntil: new Date("2099-01-01") });
	freeReader = await m.Contact.create({ accountId: owner.accountId, newsletterId: owner.newsletterId, email: "free@example.com", status: "active", tier: "free" });
});

after(() => t?.app.stop());

describe("the owner's side", () => {
	test("sets the limits, which are checked and kept apart for each account", async () => {
		assert.deepEqual((await get(owner, `/gift-links?newsletter=${owner.slug}`)).body.settings, { newsletterId: owner.newsletterId, enabled: false, perReaderPerMonth: 3, opensPerLink: 10, days: 30 });
		const saved = await t.api(owner.key, "PATCH", `/newsletters/${owner.slug}/gift-links`, { enabled: true, opensPerLink: 2 });
		assert.deepEqual([saved.status, saved.body.enabled, saved.body.opensPerLink, saved.body.days], [200, true, 2, 30]);
		t.assertError(await t.api(owner.key, "PATCH", `/newsletters/${owner.slug}/gift-links`, { days: 91 }), 400, "validation_failed");
		t.assertError(await t.api(owner.key, "PATCH", `/newsletters/${owner.slug}/gift-links`, { perReaderPerMonth: 0 }), 400, "validation_failed");
		t.assertError(await t.api(other.key, "PATCH", `/newsletters/${owner.slug}/gift-links`, { enabled: false }), 404, "not_found");
		assert.equal((await get(owner, `/gift-links?newsletter=${owner.slug}`)).body.settings.enabled, true);
	});

	test("makes a link to a paid issue only, one that has a page", async () => {
		const made = await t.api(owner.key, "POST", "/gift-links", { newsletter: owner.slug, campaign: String(paidIssue._id), note: "For the reviewer" });
		assert.equal(made.status, 200, JSON.stringify(made.body));
		assert.match(made.body.url, new RegExp(`/p/paid-one-${owner.slug}\\?gift=[A-Za-z0-9_-]{22}$`));
		assert.deepEqual([made.body.createdBy, made.body.status, made.body.opens, made.body.maxOpens, made.body.note, made.body.reader], ["owner", "active", 0, 2, "For the reviewer", null]);
		t.assertError(await t.api(owner.key, "POST", "/gift-links", { newsletter: owner.slug, campaign: String(freeIssue._id) }), 409, "conflict");
		t.assertError(await t.api(owner.key, "POST", "/gift-links", { newsletter: owner.slug, campaign: "6650f1c2e9b1d4a012345678" }), 404, "not_found");
		t.assertError(await t.api(other.key, "POST", "/gift-links", { newsletter: owner.slug, campaign: String(paidIssue._id) }), 404, "not_found");
		const draft = await m.Campaign.create({ accountId: owner.accountId, newsletterId: owner.newsletterId, subject: "Draft", status: "draft", audience: "paid", format: "rich", html: "<p>x</p>" });
		t.assertError(await t.api(owner.key, "POST", "/gift-links", { newsletter: owner.slug, campaign: String(draft._id) }), 409, "conflict");
	});

	test("lists the links with their counts, and nobody else's account sees them", async () => {
		const listed = await get(owner, `/gift-links?newsletter=${owner.slug}`);
		assert.equal(listed.body.links.length, 1);
		assert.equal(listed.body.links[0].issue.subject, "paid-one");
		assert.deepEqual((await get(other, `/gift-links?newsletter=${other.slug}`)).body.links, []);
		const filtered = await get(owner, `/gift-links?newsletter=${owner.slug}&campaign=${secondPaidIssue._id}`);
		assert.deepEqual(filtered.body.links, []);
		t.assertError(await get(owner, `/gift-links?newsletter=${owner.slug}&campaign=nope`), 400, "validation_failed");
	});
});

describe("opening a link", () => {
	let link;

	before(async () => {
		const made = await t.api(owner.key, "POST", "/gift-links", { newsletter: owner.slug, campaign: String(paidIssue._id), opens: 2 });
		link = { id: made.body.id, code: codeOf(made.body.url) };
	});

	test("gives anyone the whole of that one issue, and the page itself stays a teaser for everyone else", async () => {
		const first = browser();
		const answer = await open(first, paidIssue, link.code);
		assert.equal(answer.unlocked, true);
		assert.match(answer.html, new RegExp(`${SECRET}_paid-one`));
		assert.equal(answer.audioAllowed, false);
		assert.equal(answer.canShare, undefined);
		const { renderWebIssue } = await import("../lib/web-issue.js");
		assert.doesNotMatch(renderWebIssue({ newsletter, issue: paidIssue.toObject() }).html, new RegExp(SECRET));

		const wrongIssue = await open(browser(), secondPaidIssue, link.code);
		assert.deepEqual([wrongIssue.unlocked, wrongIssue.reason], [false, "unknown"]);
		assert.equal((await open(browser(), freeIssue, link.code)).unlocked, false);
		for (const code of ["", "short", "x".repeat(22), `${link.code.slice(0, 21)}_`]) assert.equal((await open(browser(), paidIssue, code)).unlocked, false, code);
		assert.equal((await m.GiftLink.findOne({ _id: link.id }).setOptions({ crossAccount: true }).lean()).opens, 1);
		link.first = first;
	});

	test("counts a browser once, however often it reads, and stops at the limit for new ones", async () => {
		for (let read = 0; read < 3; read++) assert.equal((await open(link.first, paidIssue, link.code)).unlocked, true);
		assert.equal((await m.GiftLink.findOne({ _id: link.id }).setOptions({ crossAccount: true }).lean()).opens, 1);
		assert.equal((await open(browser(), paidIssue, link.code)).unlocked, true);
		const listed = (await get(owner, `/gift-links?newsletter=${owner.slug}`)).body.links.find(({ id }) => id === link.id);
		assert.deepEqual([listed.opens, listed.status], [2, "used_up"]);
		const late = await open(browser(), paidIssue, link.code);
		assert.deepEqual([late.unlocked, late.reason], [false, "used_up"]);
		assert.equal((await open(link.first, paidIssue, link.code)).unlocked, true, "a browser that already opened it still reads");
		assert.equal((await open({ jar: new Map([["fs_gift_forged", "x"]]), ip: "198.51.100.250" }, paidIssue, link.code)).unlocked, false, "a made-up cookie is no place in line");
	});

	test("ends at once when taken back, and on its date", async () => {
		const revoked = await t.api(owner.key, "DELETE", `/gift-links/${link.id}`);
		assert.deepEqual([revoked.status, revoked.body.status], [200, "revoked"]);
		assert.equal((await t.api(owner.key, "DELETE", `/gift-links/${link.id}`)).body.status, "revoked", "taking it back twice is fine");
		const after = await open(link.first, paidIssue, link.code);
		assert.deepEqual([after.unlocked, after.reason], [false, "revoked"]);
		t.assertError(await t.api(other.key, "DELETE", `/gift-links/${link.id}`), 404, "not_found");

		const fresh = await t.api(owner.key, "POST", "/gift-links", { newsletter: owner.slug, campaign: String(paidIssue._id), days: 1 });
		await m.GiftLink.updateOne({ _id: fresh.body.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } }).setOptions({ crossAccount: true });
		const expired = await open(browser(), paidIssue, codeOf(fresh.body.url));
		assert.deepEqual([expired.unlocked, expired.reason], [false, "expired"]);
		assert.equal((await get(owner, `/gift-links?newsletter=${owner.slug}`)).body.links.find(({ id }) => id === fresh.body.id).status, "expired");
	});
});

describe("a paid reader's own link", () => {
	const make = (who, issue = paidIssue) => as(who, async () => (await gifts()).createReaderGiftLink({ slug: owner.slug, post: issue.archiveSlug }));

	test("is offered to a paid reader once the owner allows it, and only on a paid issue they can read", async () => {
		const reader = await readerBrowser(paidReader);
		const access = await import("../lib/reader-access.js");
		const unlock = (who, issue) => as(who, () => access.unlockIssueForReader({ slug: owner.slug, post: issue.archiveSlug }));

		await m.Newsletter.updateOne({ accountId: owner.accountId, _id: owner.newsletterId }, { $set: { "giftLinks.enabled": false } });
		assert.equal((await unlock(reader, paidIssue)).canShare, undefined);
		assert.match((await make(reader)).error, /Sharing is off/);

		await m.Newsletter.updateOne({ accountId: owner.accountId, _id: owner.newsletterId }, { $set: { "giftLinks.enabled": true } });
		assert.equal((await unlock(reader, paidIssue)).canShare, true);
		assert.equal((await unlock(reader, freeIssue)).canShare, undefined);
		assert.match((await make(reader, freeIssue)).error, /Only paid issues/);
		assert.match((await make(browser())).error, /Your session ended/);
		assert.match((await make(await readerBrowser(freeReader))).error, /paid subscribers/);
	});

	test("makes a link within the month's allowance, which the owner sees as the reader's", async () => {
		const reader = await readerBrowser(paidReader);
		const first = await make(reader);
		assert.match(first.url, /\?gift=[A-Za-z0-9_-]{22}$/);
		assert.deepEqual([first.opens, first.days, first.left], [2, 30, 2]);
		assert.equal((await open(browser(), paidIssue, codeOf(first.url))).unlocked, true, "the friend reads it");
		await make(reader);
		assert.equal((await make(reader)).left, 0);
		assert.match((await make(reader)).error, /3 issues a month/);

		const mine = (await get(owner, `/gift-links?newsletter=${owner.slug}&limit=100`)).body.links.filter(({ createdBy }) => createdBy === "reader");
		assert.equal(mine.length, 3);
		assert.ok(mine.every(({ reader: email }) => email === "paying@example.com"));
		await m.GiftLink.updateMany({ contactId: paidReader._id }, { $set: { createdAt: new Date(Date.now() - 40 * 86_400_000) } }).setOptions({ crossAccount: true });
		assert.ok((await make(reader)).url, "the allowance starts over with the month");
	});

	test("goes when the reader's access does", async () => {
		const reader = await readerBrowser(paidReader);
		await m.Contact.updateOne({ accountId: owner.accountId, _id: paidReader._id }, { $set: { tier: "free" } });
		assert.match((await make(reader)).error, /paid subscribers/);
		await m.Contact.updateOne({ accountId: owner.accountId, _id: paidReader._id }, { $set: { tier: "paid" } });
		await m.Campaign.updateOne({ accountId: owner.accountId, _id: paidIssue._id }, { $set: { audienceTiers: ["gold"] } });
		assert.match((await make(reader)).error, /paid subscribers/);
		await m.Campaign.updateOne({ accountId: owner.accountId, _id: paidIssue._id }, { $unset: { audienceTiers: 1 } });
	});
});

describe("the dashboard", () => {
	test("makes, shows and takes back links with the same actions", async () => {
		const actions = await import("../app/(app)/gift-links/actions.js");
		const form = (fields) => Object.assign(new FormData(), {}) && Object.entries(fields).reduce((data, [key, value]) => (data.set(key, value), data), new FormData());
		const made = await as(owner, () => actions.makeGiftLink(null, form({ newsletter: owner.slug, campaign: String(secondPaidIssue._id), opens: "3", days: "7", note: "Dashboard" })));
		assert.match(made.url, /paid-two/);
		assert.match((await as(owner, () => actions.makeGiftLink(null, form({ newsletter: owner.slug, campaign: String(freeIssue._id) })))).error, /free/);
		const saved = await as(owner, () => actions.saveGiftLinkSettings(null, form({ newsletter: owner.slug, enabled: "on", perReaderPerMonth: "5", opensPerLink: "4", days: "14" })));
		assert.equal(saved.ok, true);
		assert.deepEqual((await get(owner, `/gift-links?newsletter=${owner.slug}`)).body.settings, { newsletterId: owner.newsletterId, enabled: true, perReaderPerMonth: 5, opensPerLink: 4, days: 14 });

		const page = (await import("../app/(app)/gift-links/page.js")).default;
		const markup = renderToStaticMarkup(await as(owner, () => page()));
		assert.match(markup, /Make a link/);
		assert.match(markup, /Dashboard/);
		const id = (await get(owner, `/gift-links?newsletter=${owner.slug}&limit=100`)).body.links.find(({ note }) => note === "Dashboard").id;
		assert.equal((await as(owner, () => actions.revokeGiftLink(id))).ok, true);
		assert.equal((await get(owner, `/gift-links?newsletter=${owner.slug}&limit=100`)).body.links.find((link) => link.id === id).status, "revoked");
	});

	test("the links go with the account's export and its deletion", async () => {
		const { CONTENT_MODELS } = await import("../lib/account-purge.js");
		assert.ok(CONTENT_MODELS.includes(m.GiftLink));
		const exported = await import("../lib/account-export.js");
		assert.ok(exported, "the export module loads with the model in its list");
	});
});

void createElement;
