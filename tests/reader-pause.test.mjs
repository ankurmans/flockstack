import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { mockStripe, startTestApp } from "./helpers/app.mjs";
import { installFakeStripe } from "./helpers/shop.mjs";
import { retentionModels, retentionReader } from "./helpers/reader-retention.mjs";
let app, m, fake;
before(async () => { app = await startTestApp(); fake = installFakeStripe(); m = { ...(await retentionModels()), pauses: await import("../lib/reader-pause.js") }; });
after(() => app?.stop());
const pause = (s, fields = {}) => m.pauses.scheduleReaderPause({ ...s.target, months: 3, externalId: randomUUID(), ...fields });
test("native reader pause starts at paid expiry and confirms an owned bounded resume without changing price or billing mode", async () => {
	const s = await retentionReader(m, fake), start = fake.requests.length, id = randomUUID();
	const result = await pause(s, { externalId: id });
	assert.equal(result.record.pauseState, "scheduled"); assert.equal(result.record.pauseMonths, 3);
	assert.equal(+new Date(result.record.pauseAt), s.subscription.items.data[0].current_period_end * 1000);
	assert.ok(+new Date(result.record.resumeAt) > +new Date(result.record.pauseAt)); assert.equal(result.context.contact.tier, "paid");
	assert.equal(+new Date(result.context.contact.paidPersonal.until), +new Date(result.record.pauseAt), "scheduling a future resume never extends access into unpaid months");
	const schedule = fake.schedules.get(result.record.stripeScheduleId); assert.equal(schedule.metadata.kind, "reader_pause"); assert.equal(schedule.metadata.contactId, String(s.contact._id));
	const calls = fake.requests.slice(start), create = calls.find(request => request.path === "/v1/subscription_schedules" && request.method === "POST");
	assert.equal(create.apiVersion, "2026-09-30.endive"); assert.equal(create.params.pause_schedules[0].resume.settings.payment_behavior, "resume_on_payment_success");
	assert.equal(calls.some(request => request.params.billing_mode || request.params.pause_collection || request.params.phases || /\/(charges|pay|cancel|pause)$/.test(request.path)), false);
	assert.equal((await pause(s, { externalId: id })).duplicate, true); assert.equal(fake.schedules.size >= 1, true);
	assert.equal([...fake.schedules.values()].filter(row => row.subscription === s.subscription.id).length, 1);
});
test("classic billing, foreign schedules and creator-disabled new pauses are refused without provider mutations", async () => {
	for (const fields of [{ billing_mode: { type: "classic" } }, { schedule: "sub_sched_foreign" }]) {
		const s = await retentionReader(m, fake, fields), start = fake.requests.length; await assert.rejects(pause(s), error => error.code === "conflict");
		assert.equal(fake.requests.slice(start).some(request => request.method !== "GET"), false);
	}
	const s = await retentionReader(m, fake); await m.Newsletter.updateOne({ accountId: s.user.accountId, _id: s.newsletter._id }, { $set: { "readerRetention.pauseEnabled": false } }); await assert.rejects(pause(s), /hasn't enabled/);
});
test("an unknown schedule creation response reuses its native idempotency identity and saved original period", async () => {
	const s = await retentionReader(m, fake), id = randomUUID(), handler = fake.handler; let lose = true;
	mockStripe(async request => { const answer = await handler(request); if (lose && request.method === "POST" && request.path === "/v1/subscription_schedules") { lose = false; throw new DOMException("Unknown response", "TimeoutError"); } return answer; });
	try { await assert.rejects(pause(s, { externalId: id }), error => error.code === "unavailable"); }
	finally { mockStripe(handler); }
	const recovered = await pause(s, { externalId: id }); assert.equal(recovered.record.pauseState, "scheduled");
	assert.equal([...fake.schedules.values()].filter(row => row.subscription === s.subscription.id).length, 1);
	const calls = fake.requests.filter(request => request.method === "POST" && request.path === "/v1/subscription_schedules" && request.params.from_subscription === s.subscription.id);
	assert.equal(calls.length, 2); assert.equal(calls[0].idempotencyKey, calls[1].idempotencyKey); assert.deepEqual(calls[0].params, calls[1].params);
});
test("known schedule recovery needs no creation after 23 hours, while unknown old creation never retries blindly", async () => {
	const known = await retentionReader(m, fake), id = randomUUID();
	const handler = fake.handler; let fail = true;
	mockStripe(async request => { if (fail && request.method === "POST" && /^\/v1\/subscription_schedules\/sub_sched_/.test(request.path)) { fail = false; return { status: 500, error: { message: "Metadata unavailable", code: "api_error" } }; } return handler(request); });
	try { await assert.rejects(pause(known, { externalId: id }), error => error.code === "unavailable"); } finally { mockStripe(handler); }
	const record = await m.Retention.findOne({ accountId: known.user.accountId, contactId: known.contact._id }).lean(); assert.ok(record.pending.scheduleId);
	await m.Retention.updateOne({ accountId: known.user.accountId, _id: record._id }, { $set: { "pending.startedAt": new Date(Date.now() - 86400000) } });
	assert.equal((await pause(known, { externalId: id })).record.pauseState, "scheduled");
	const unknown = await retentionReader(m, fake), unknownId = randomUUID(), context = await m.store.readCurrentReaderBilling(unknown.target);
	const params = m.rules.readerPauseScheduleParams(context.subscription, context.details, 3);
	const claimed = await m.store.claimReaderRetention(context, { kind: "pause", externalId: unknownId, request: { months: 3 }, params, extra: { months: 3 } });
	await m.Retention.updateOne({ accountId: unknown.user.accountId, _id: claimed.record._id }, { $set: { "pending.startedAt": new Date(Date.now() - 86400000) } });
	const start = fake.requests.length; await assert.rejects(pause(unknown, { externalId: unknownId }), /older than 23 hours/); assert.equal(fake.requests.slice(start).some(request => request.method !== "GET"), false);
});
test("canceling an owned future pause preserves the subscription, and a changed entry is never cleared", async () => {
	const s = await retentionReader(m, fake), planned = await pause(s), id = randomUUID();
	const cleared = await m.pauses.cancelScheduledReaderPause({ ...s.target, externalId: id }); assert.equal(cleared.record.pauseState, "ended"); assert.equal(s.subscription.status, "active"); assert.deepEqual(fake.schedules.get(planned.record.stripeScheduleId).pause_schedules, []);
	assert.equal((await m.pauses.cancelScheduledReaderPause({ ...s.target, externalId: id })).duplicate, true);
	const changed = await retentionReader(m, fake), other = await pause(changed); fake.schedules.get(other.record.stripeScheduleId).pause_schedules[0].key = "another-pause";
	await assert.rejects(m.pauses.cancelScheduledReaderPause({ ...changed.target, externalId: randomUUID() }), /entry changed/);
});

test("removing a future pause releases unchanged owned terms for a new pause but preserves later creator phase edits", async () => {
	const s = await retentionReader(m, fake), first = await pause(s);
	await m.pauses.cancelScheduledReaderPause({ ...s.target, externalId: randomUUID() }); assert.equal(s.subscription.schedule, null); assert.equal(fake.schedules.get(first.record.stripeScheduleId).status, "released");
	const next = await pause(s, { months: 6 }); assert.notEqual(next.record.stripeScheduleId, first.record.stripeScheduleId); assert.equal(next.record.pauseMonths, 6);
	const changed = await retentionReader(m, fake), planned = await pause(changed), schedule = fake.schedules.get(planned.record.stripeScheduleId);
	schedule.phases.push({ items: [{ price: "price_creator_future", quantity: 1 }] }); const phases = structuredClone(schedule.phases);
	await m.pauses.cancelScheduledReaderPause({ ...changed.target, externalId: randomUUID() }); assert.deepEqual(schedule.phases, phases); assert.equal(schedule.status, "active"); assert.deepEqual(schedule.pause_schedules, []);
});

async function pausedReader(extra = {}) {
	const s = await retentionReader(m, fake, extra), planned = await pause(s), at = Math.floor(Date.now() / 1000) - 60;
	const schedule = fake.schedules.get(planned.record.stripeScheduleId); schedule.pause_schedules[0].pause.pause_at = at;
	s.subscription.status = "paused"; s.subscription.current_period_end = at; s.subscription.items.data[0].current_period_end = at;
	s.subscription.status_details = { paused: { type: "subscription", subscription: { type: "pause_requested" }, transitioned_at: at } };
	await m.Retention.updateOne({ accountId: s.user.accountId, _id: planned.record._id }, { $set: { pauseAt: new Date(at * 1000), pauseState: "paused" } });
	return { ...s, planned, at };
}
test("early resume requires billing confirmation and only restores access after Stripe reports an active period", async () => {
	const s = await pausedReader(), id = randomUUID(); s.subscription.discounts = [{ id: "di_existing" }];
	await assert.rejects(m.pauses.resumeReaderSubscription({ ...s.target, externalId: id }), /Confirm that resuming/);
	const resumed = await m.pauses.resumeReaderSubscription({ ...s.target, externalId: id, confirmBilling: true });
	assert.equal(resumed.context.subscription.status, "active"); assert.equal(resumed.context.contact.tier, "paid"); assert.equal(resumed.record.pauseState, "ended");
	assert.deepEqual(s.subscription.discounts, [{ id: "di_existing" }]);
	assert.equal((await m.pauses.resumeReaderSubscription({ ...s.target, externalId: id, confirmBilling: true })).duplicate, true);
});
test("a resume attempt awaiting payment leaves the personal source paused and cannot start another invoice", async () => {
	const s = await pausedReader({ resumeRequiresPayment: true });
	const result = await m.pauses.resumeReaderSubscription({ ...s.target, externalId: randomUUID(), confirmBilling: true });
	assert.equal(result.record.pauseState, "resume_pending"); assert.equal(result.context.contact.tier, "free"); assert.equal(result.context.contact.paidPersonal.status, "paused"); assert.equal(result.context.subscription.latest_invoice.status, "open");
	const start = fake.requests.length;
	await assert.rejects(m.pauses.resumeReaderSubscription({ ...s.target, externalId: randomUUID(), confirmBilling: true }), /already awaiting payment/);
	assert.equal(fake.requests.slice(start).some(request => request.method !== "GET"), false);
});
test("a released native schedule can resume its own pause directly, but trial or unrelated pauses cannot", async () => {
	const s = await pausedReader(); s.subscription.schedule = null;
	const result = await m.pauses.resumeReaderSubscription({ ...s.target, externalId: randomUUID(), confirmBilling: true }); assert.equal(result.context.subscription.status, "active");
	assert.ok(fake.requests.some(request => request.path === `/v1/subscriptions/${s.subscription.id}/resume` && request.params.payment_behavior === "resume_on_payment_success"));
	const other = await pausedReader(); other.subscription.status_details.paused.subscription.type = "trial_end_without_payment_method";
	const start = fake.requests.length; await assert.rejects(m.pauses.resumeReaderSubscription({ ...other.target, externalId: randomUUID(), confirmBilling: true }), /no longer matches/);
	assert.equal(fake.requests.slice(start).some(request => request.method !== "GET"), false);
});
test("an unsubscribe after a resume is claimed stops renewed billing before the native provider write", async () => {
	const s = await pausedReader(), original = m.Retention.findOneAndUpdate, start = fake.requests.length;
	m.Retention.findOneAndUpdate = function (filter, change, options) {
		const query = original.call(this, filter, change, options), lean = query.lean.bind(query);
		query.lean = async () => { const result = await lean(); if (change?.$set?.pending?.kind === "resume") await m.Contact.updateOne({ accountId: s.user.accountId, _id: s.contact._id }, { $set: { status: "unsubscribed" } }); return result; };
		return query;
	};
	try { await assert.rejects(m.pauses.resumeReaderSubscription({ ...s.target, externalId: randomUUID(), confirmBilling: true }), /no longer subscribed/); }
	finally { m.Retention.findOneAndUpdate = original; }
	assert.equal(fake.requests.slice(start).some(request => request.method !== "GET"), false);
	assert.equal(s.subscription.status, "paused");
});
