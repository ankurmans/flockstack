import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { mockStripe, startTestApp } from "./helpers/app.mjs";
import { installFakeStripe } from "./helpers/shop.mjs";
import { retentionModels, retentionReader } from "./helpers/reader-retention.mjs";
let app, m, fake;
before(async () => { app = await startTestApp(); fake = installFakeStripe(); m = await retentionModels(); });
after(() => app?.stop());
test("reader billing reads pin the API version and merge only the current observed personal source", async () => {
	const s = await retentionReader(m, fake), before = fake.requests.length;
	const context = await m.store.readCurrentReaderBilling(s.target);
	assert.equal(context.details.supported, true); assert.equal(context.record, null); assert.equal(context.contact.tier, "paid");
	const reads = fake.requests.slice(before); assert.ok(reads.every(request => request.method === "GET")); assert.equal(reads[0].apiVersion, "2026-09-30.endive");
	s.subscription.status = "paused";
	const paused = await m.store.readCurrentReaderBilling(s.target); assert.equal(paused.contact.tier, "free"); assert.equal(paused.contact.paidPersonal.status, "paused");
	await m.Contact.updateOne({ accountId: s.user.accountId, _id: s.contact._id }, { $set: { grant: { kind: "comp", tierId: "paid", until: new Date(Date.now() + 86400000), at: new Date() } } });
	const gift = await m.store.readCurrentReaderBilling(s.target); assert.equal(gift.contact.tier, "paid"); assert.equal(gift.contact.paidSource, "grant"); assert.equal(gift.contact.paidPersonal.status, "paused");
});
test("reader billing cannot read another account, newsletter, customer or group source", async () => {
	const s = await retentionReader(m, fake), other = await retentionReader(m, fake);
	await assert.rejects(m.store.readCurrentReaderBilling({ ...s.target, account: other.user.account }), error => error.code === "not_found");
	s.subscription.customer = "cus_foreign"; await assert.rejects(m.store.readCurrentReaderBilling(s.target), /no matching personal/);
	s.subscription.customer = s.customer.id; s.subscription.metadata.kind = "group_subscription"; await assert.rejects(m.store.readCurrentReaderBilling(s.target), /no matching personal/);
});
test("a slow active read cannot restore paid access over a newer paused observation", async () => {
	const s = await retentionReader(m, fake), handler = fake.handler;
	let release, entered;
	const waiting = new Promise(resolve => { entered = resolve; }); let held = false;
	mockStripe(async request => {
		if (!held && request.method === "GET" && request.path === `/v1/subscriptions/${s.subscription.id}`) { held = true; const captured = structuredClone(await handler(request)); entered(); await new Promise(resolve => { release = resolve; }); return captured; }
		return handler(request);
	});
	try {
		const old = m.store.readCurrentReaderBilling(s.target); await waiting;
		s.subscription.status = "paused"; await m.store.readCurrentReaderBilling(s.target); release();
		await assert.rejects(old, /newer reader billing observation/);
	} finally { mockStripe(handler); }
	const current = await m.Contact.findOne({ accountId: s.user.accountId, _id: s.contact._id }).lean(); assert.equal(current.tier, "free"); assert.equal(current.paidPersonal.status, "paused");
});
test("billing change claims serialize distinct requests and preserve retry parameters and stale-write protection", async () => {
	const s = await retentionReader(m, fake), context = await m.store.readCurrentReaderBilling(s.target);
	const requests = [1, 3].map(months => ({ kind: "pause", externalId: randomUUID(), request: { months }, params: { fixedPeriod: 123, months }, extra: { months } }));
	const attempts = await Promise.allSettled(requests.map(input => m.store.claimReaderRetention(context, input)));
	const success = attempts.findIndex(result => result.status === "fulfilled"), first = attempts[success].value; assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
	const retry = await m.store.claimReaderRetention(context, { ...requests[success], params: { fixedPeriod: 999 } });
	assert.equal(retry.record.pending.params.fixedPeriod, 123);
	await assert.rejects(m.store.finishReaderRetention(s.user.account, first, { pauseState: "scheduled" }), /newer reader billing request/);
	await m.store.finishReaderRetention(s.user.account, retry, { pauseState: "scheduled" });
	assert.equal((await m.store.claimReaderRetention(context, requests[success])).duplicate, true);
	await assert.rejects(m.store.claimReaderRetention(context, { ...requests[success], request: { months: 6 } }), /another billing change/);
	assert.throws(() => m.store.assertKnownRetentionCreation({ pending: { startedAt: new Date(Date.now() - 86400000) } }), /older than 23 hours/);
});
