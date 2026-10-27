import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { mockStripe, startTestApp } from "./helpers/app.mjs";
import { installFakeStripe } from "./helpers/shop.mjs";
import { retentionModels, retentionReader } from "./helpers/reader-retention.mjs";
let app, m, fake;
before(async () => { app = await startTestApp(); fake = installFakeStripe(); m = { ...(await retentionModels()), pauses: await import("../lib/reader-pause.js"), cancellation: await import("../lib/reader-cancellation.js") }; });
after(() => app?.stop());
const cancel = (s, fields = {}) => m.cancellation.cancelReaderSubscription({ ...s.target, externalId: randomUUID(), confirm: true, ...fields });
test("cancellation keeps an active reader's paid period and newsletter signup, and optional feedback can always be skipped", async () => {
	const s = await retentionReader(m, fake), id = randomUUID(), start = fake.requests.length;
	await assert.rejects(cancel(s, { externalId: id, response: { reason: "cost" } }), /share the optional/);
	assert.equal(fake.requests.slice(start).some(request => request.method !== "GET"), false);
	const result = await cancel(s, { externalId: id });
	assert.equal(result.context.subscription.cancel_at_period_end, true); assert.equal(result.context.contact.tier, "paid"); assert.equal(result.context.contact.status, "active"); assert.equal(result.responseRecorded, false);
	assert.equal(+new Date(result.context.contact.paidPersonal.until), s.subscription.items.data[0].current_period_end * 1000);
	const writes = fake.requests.slice(start).filter(request => request.method !== "GET"); assert.equal(writes.length, 1); assert.equal(writes[0].method, "POST"); assert.equal(writes[0].params.proration_behavior, "none");
	assert.equal(await m.Response.countDocuments({ accountId: s.user.accountId }), 0);
});
test("consented survey content stays with the creator, is stored once and confirms only an observed cancellation", async () => {
	const s = await retentionReader(m, fake), id = randomUUID(), comment = "PRIVATE_OPTIONAL_REASON", start = fake.requests.length;
	const result = await cancel(s, { externalId: id, response: { reason: "not_reading", comment, shareWithCreator: true } });
	assert.equal(result.responseRecorded, true);
	const response = await m.Response.findOne({ accountId: s.user.accountId, retentionId: result.record._id }).lean(); assert.equal(response.comment, comment); assert.ok(response.sharedAt); assert.ok(response.cancellationConfirmedAt);
	assert.equal(JSON.stringify(fake.requests.slice(start)).includes(comment), false, "the private response is not sent to Stripe");
	await cancel(s, { externalId: id, response: { reason: "other", comment: "Changed retry text", shareWithCreator: true } });
	assert.equal(await m.Response.countDocuments({ accountId: s.user.accountId, retentionId: result.record._id }), 1); assert.equal((await m.Response.findOne({ accountId: s.user.accountId, _id: response._id }).lean()).comment, comment);
});
test("lost cancellation responses recover the existing state and preserve the first consented response", async () => {
	const s = await retentionReader(m, fake), id = randomUUID(), handler = fake.handler; let lose = true;
	mockStripe(async request => { const answer = await handler(request); if (lose && request.method === "POST" && request.path === `/v1/subscriptions/${s.subscription.id}`) { lose = false; throw new DOMException("Unknown response", "TimeoutError"); } return answer; });
	try { await assert.rejects(cancel(s, { externalId: id, response: { reason: "temporary", comment: "Away", shareWithCreator: true } }), error => error.code === "unavailable"); } finally { mockStripe(handler); }
	const requested = await m.Response.findOne({ accountId: s.user.accountId }).lean(); assert.equal(requested.cancellationConfirmedAt, undefined);
	const recovered = await cancel(s, { externalId: id }); assert.equal(recovered.responseRecorded, true); assert.ok((await m.Response.findOne({ accountId: s.user.accountId }).lean()).cancellationConfirmedAt);
	assert.equal(fake.requests.filter(request => request.method === "POST" && request.path === `/v1/subscriptions/${s.subscription.id}`).length, 1);
});
test("an owned paused subscription cancels without a final invoice or refund, preserving another valid access source", async () => {
	const s = await retentionReader(m, fake), planned = await m.pauses.scheduleReaderPause({ ...s.target, months: 1, externalId: randomUUID() });
	s.subscription.status = "paused";
	await m.Contact.updateOne({ accountId: s.user.accountId, _id: s.contact._id }, { $set: { grant: { kind: "comp", tierId: "paid", until: new Date(Date.now() + 86400000), at: new Date() } } });
	const start = fake.requests.length, result = await cancel(s);
	assert.equal(result.context.subscription.status, "canceled"); assert.equal(result.context.contact.paidPersonal.status, "canceled"); assert.equal(result.context.contact.tier, "paid"); assert.equal(result.context.contact.paidSource, "grant"); assert.equal(result.context.contact.status, "active");
	assert.equal(fake.schedules.get(planned.record.stripeScheduleId).status, "released");
	const deletion = fake.requests.slice(start).find(request => request.method === "DELETE"); assert.equal(deletion.params.invoice_now, "false"); assert.equal(deletion.params.prorate, "false");
	assert.equal(fake.requests.slice(start).some(request => /refund|\/pay$|\/charges/.test(request.path)), false);
});
test("foreign schedules are not taken over and a disabled survey never obstructs cancellation", async () => {
	const foreign = await retentionReader(m, fake, { schedule: "sub_sched_foreign" }), start = fake.requests.length;
	await assert.rejects(cancel(foreign), /another schedule/); assert.equal(fake.requests.slice(start).some(request => request.method !== "GET"), false);
	const closed = await retentionReader(m, fake); await m.Newsletter.updateOne({ accountId: closed.user.accountId, _id: closed.newsletter._id }, { $set: { "readerRetention.surveyEnabled": false } });
	const result = await cancel(closed, { response: { reason: "cost", comment: "Not collected" } }); assert.equal(result.context.subscription.cancel_at_period_end, true); assert.equal(result.responseRecorded, false); assert.equal(await m.Response.countDocuments({ accountId: closed.user.accountId }), 0);
});
