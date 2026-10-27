import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { as, anonymous } from "./helpers/app.mjs";
import { setupAudienceTests } from "./helpers/audience.mjs";
let t, m, owner, other, newsletter, reader, visitor, issues, meter, MeteredRead;
before(async () => {
	t = await setupAudienceTests(); m = t.m; owner = await t.customer("meter-owner@example.com"); other = await t.customer("meter-other@example.com");
	await m.Newsletter.updateOne({ accountId: owner.accountId, _id: owner.newsletterId }, { $set: { archiveEnabled: true, meteredReadsPerMonth: 2 } });
	newsletter = await m.Newsletter.findOne({ accountId: owner.accountId, _id: owner.newsletterId }).lean();
	reader = await m.Contact.create({ accountId: owner.accountId, newsletterId: owner.newsletterId, email: "meter-reader@example.com", status: "active", tier: "free" });
	visitor = { jar: new Map(), ip: "198.51.100.171" }; await as(visitor, () => import("../lib/reader-session.js").then((session) => session.startReaderSession(newsletter, reader._id)));
	issues = await m.Campaign.insertMany(Array.from({ length: 5 }, (_, i) => ({ accountId: owner.accountId, newsletterId: owner.newsletterId, subject: `Paid issue ${i}`, archiveSlug: `meter-${i}`, status: "sent", publishTo: "both", audience: "paid", format: "rich", html: `<p>Opening</p><p>SECRET_METER_${i}</p>`, sentAt: new Date() })));
	meter = await import("../lib/metered-reading.js"); MeteredRead = (await import("../models/MeteredRead.js")).default;
});
after(() => t?.app.stop());
const claim = (i, more = {}, who = visitor) => as(who, () => meter.claimMeteredIssue({ slug: owner.slug, post: issues[i].archiveSlug, confirmed: true, ...more }));
const unlock = (i, who = visitor) => as(who, () => import("../lib/reader-access.js").then((access) => access.unlockIssueForReader({ slug: owner.slug, post: issues[i].archiveSlug })));
test("page reads inspect the meter without spending it, and claims need explicit reader consent", async () => {
	const answer = await unlock(0); assert.equal(answer.unlocked, false); assert.equal(answer.meter.remaining, 2); assert.equal(await MeteredRead.countDocuments({ accountId: owner.accountId }), 0);
	assert.ok((await claim(0, { confirmed: false })).error);
	assert.ok((await anonymous(() => meter.claimMeteredIssue({ slug: owner.slug, post: issues[0].archiveSlug, confirmed: true }))).error);
	assert.ok((await claim(0, {}, owner)).error, "owner auth is not a reader session");
	assert.equal(await MeteredRead.countDocuments({ accountId: owner.accountId }), 0);
});
test("racing claims never exceed the month cap and the same issue is counted once", async () => {
	const first = await Promise.all(Array.from({ length: 12 }, () => claim(0))); assert.ok(first.every((r) => r.ok));
	let record = await MeteredRead.findOne({ accountId: owner.accountId }).lean(); assert.equal(record.count, 1); assert.equal(record.issueIds.length, 1);
	const rest = await Promise.all([claim(1), claim(2), claim(3), claim(4)]); assert.equal(rest.filter((r) => r.ok).length, 1);
	record = await MeteredRead.findOne({ accountId: owner.accountId }).lean(); assert.equal(record.count, 2); assert.equal(record.issueIds.length, 2);
	const answer = await unlock(0); assert.equal(answer.unlocked, true); assert.match(answer.html, /SECRET_METER_0/); assert.equal(answer.audioAllowed, false);
	const { getAudioAccess } = await import("../lib/reader-access.js"); assert.deepEqual(await as(visitor, () => getAudioAccess({ newsletter, issue: issues[0], file: { scope: "paid" } })), { ok: false, status: 403 });
});
test("current subscription, publication settings and tier restrictions are always rechecked", async () => {
	await m.Newsletter.updateOne({ accountId: owner.accountId, _id: newsletter._id }, { $set: { meteredReadsPerMonth: 0 } }); assert.equal((await unlock(0)).unlocked, false);
	await m.Newsletter.updateOne({ accountId: owner.accountId, _id: newsletter._id }, { $set: { meteredReadsPerMonth: 2 } });
	await m.Campaign.updateOne({ accountId: owner.accountId, _id: issues[0]._id }, { $set: { audienceTiers: ["premium"] } }); assert.equal((await unlock(0)).unlocked, false); assert.ok((await claim(0)).error);
	await m.Campaign.updateOne({ accountId: owner.accountId, _id: issues[0]._id }, { $unset: { audienceTiers: 1 }, $set: { publishTo: "email" } }); assert.equal((await unlock(0)).unlocked, false);
	await m.Campaign.updateOne({ accountId: owner.accountId, _id: issues[0]._id }, { $set: { publishTo: "both" } });
	await m.Contact.updateOne({ accountId: owner.accountId, _id: reader._id }, { $set: { status: "unsubscribed" } }); assert.deepEqual(await unlock(0), { unlocked: false, signedIn: false }); assert.ok((await claim(0)).error);
	await m.Contact.updateOne({ accountId: owner.accountId, _id: reader._id }, { $set: { status: "active" } });
	const foreign = { jar: new Map(), ip: "198.51.100.172" }; const otherPublication = await m.Newsletter.findOne({ accountId: other.accountId, _id: other.newsletterId }).lean(); const otherReader = await m.Contact.create({ accountId: other.accountId, newsletterId: other.newsletterId, email: "other-meter@example.com", status: "active" });
	await as(foreign, () => import("../lib/reader-session.js").then((session) => session.startReaderSession(otherPublication, otherReader._id))); assert.ok((await claim(0, {}, foreign)).error);
});
test("UTC months reset access and expiry, while a paid reader does not consume a free quota", async () => {
	const instant = new Date("2030-12-31T23:59:59.000Z"); const window = meter.meterPeriod(instant); assert.equal(window.period, "2030-12"); assert.equal(window.resetsAt.toISOString(), "2031-01-01T00:00:00.000Z"); assert.equal(window.expiresAt.toISOString(), "2031-01-08T00:00:00.000Z");
	assert.equal((await claim(0, { now: instant })).ok, true);
	let status = await meter.meteredReadStatus(newsletter, issues[0], reader, new Date("2031-01-01T00:00:00.000Z")); assert.equal(status.allowed, false); assert.equal(status.remaining, 2);
	await m.Contact.updateOne({ accountId: owner.accountId, _id: reader._id }, { $set: { tier: "paid", paidUntil: new Date("2099-01-01") } });
	assert.ok((await claim(4)).error); assert.equal((await unlock(4)).unlocked, true);
	assert.equal(await MeteredRead.countDocuments({ accountId: owner.accountId }), 2);
});
test("the owner setting is bounded, account scoped and available through the action registry", async () => {
	let response = await t.api(owner.key, "PATCH", "/reader-settings", { newsletter: owner.newsletterId, meteredReadsPerMonth: 21 }); assert.equal(response.status, 400);
	response = await t.api(other.key, "PATCH", "/reader-settings", { newsletter: owner.newsletterId, meteredReadsPerMonth: 3 }); assert.equal(response.status, 404);
	response = await t.api(owner.key, "GET", `/reader-settings?newsletter=${owner.newsletterId}`); assert.equal(response.status, 200); assert.equal(response.body.meteredReadsPerMonth, 2);
});

test("metered translation and web preview use the current issue grant without spending another read", async () => {
	const { setAi } = await import("./stubs/opennext-cloudflare.mjs");
	await m.Contact.updateOne({ accountId: owner.accountId, _id: reader._id }, { $set: { tier: "free" }, $unset: { paidUntil: 1 } });
	await m.Newsletter.updateOne({ accountId: owner.accountId, _id: newsletter._id }, { $set: { readerTranslations: true } });
	await m.Campaign.updateOne({ accountId: owner.accountId, _id: issues[0]._id }, { $set: { html: `<p>${"A public opening. ".repeat(40)}</p><p>METER_TRANSLATION_SECRET</p>` } });
	setAi({ async run(_model, input) { return { response: `${JSON.parse(input.messages[1].content)}\n[END_TRANSLATION]` }; } });
	try {
		const { translateForReader } = await import("../lib/reader-translation.js");
		const translate = () => as(visitor, () => translateForReader({ slug: owner.slug, post: issues[0].archiveSlug, language: "es" }));
		assert.match((await translate()).text, /METER_TRANSLATION_SECRET/);
		const preview = await t.api(owner.key, "POST", `/campaigns/${issues[0]._id}/preview`, { contactId: String(reader._id), mode: "web" }); assert.equal(preview.status, 200); assert.match(preview.body.html, /METER_TRANSLATION_SECRET/);
		await m.Newsletter.updateOne({ accountId: owner.accountId, _id: newsletter._id }, { $set: { meteredReadsPerMonth: 0 } });
		assert.doesNotMatch((await translate()).text, /METER_TRANSLATION_SECRET/, "cached full translations do not survive a revoked entitlement");
		const revoked = await t.api(owner.key, "POST", `/campaigns/${issues[0]._id}/preview`, { contactId: String(reader._id), mode: "web" }); assert.doesNotMatch(revoked.body.html, /METER_TRANSLATION_SECRET/);
		assert.equal((await MeteredRead.findOne({ accountId: owner.accountId, period: meter.meterPeriod().period }).lean()).count, 2);
	} finally { setAi(null); }
});
test("meter history expires and is covered by account exports and contact/account deletion", async () => {
	const { CONTENT_MODELS } = await import("../lib/account-purge.js"); assert.ok(CONTENT_MODELS.includes(MeteredRead));
	await MeteredRead.create({ accountId: other.accountId, newsletterId: other.newsletterId, contactId: reader._id, period: "1999-01", expiresAt: new Date("1999-02-08") });
	await (await import("../lib/agent-housekeeping.js")).runAgentHousekeeping(); assert.equal(await MeteredRead.countDocuments({ accountId: other.accountId }), 0);
	const { removeContact } = await import("../lib/contacts.js"); const current = await m.Contact.findOne({ accountId: owner.accountId, _id: reader._id }).lean(); assert.equal(await removeContact({ _id: owner.accountId }, current), true); assert.equal(await MeteredRead.countDocuments({ accountId: owner.accountId }), 0);
});
