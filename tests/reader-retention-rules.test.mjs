import assert from "node:assert/strict";
import { test } from "node:test";
import { getReaderPauseProblem, readCancellationResponse, readerPauseScheduleParams, readerPersonalSubscriptionId, readReaderSubscription } from "../lib/reader-retention-rules.js";
const now = Date.parse("2026-10-25T12:00:00Z"), end = Math.floor(now / 1000) + 864000;
const newsletter = { _id: "1".repeat(24), accountId: "2".repeat(24) };
const contact = { _id: "3".repeat(24), accountId: newsletter.accountId, newsletterId: newsletter._id, stripeCustomerId: "cus_reader", stripeSubscriptionId: "sub_reader", paidPersonal: { kind: "stripe", subscriptionId: "sub_reader", status: "active" } };
const subscription = { id: "sub_reader", customer: "cus_reader", status: "active", currency: "usd", billing_mode: { type: "flexible" }, collection_method: "charge_automatically", metadata: { flockstack: "1", kind: "paid_tier", accountId: newsletter.accountId, newsletterId: newsletter._id }, items: { data: [{ quantity: 1, current_period_end: end, price: { id: "price_reader", type: "recurring", billing_scheme: "per_unit", currency: "usd", unit_amount: 1000, recurring: { interval: "month", interval_count: 1, usage_type: "licensed" } } }] } };
test("reader billing changes bind the stored personal subscription and customer to their account and newsletter", () => {
	assert.equal(readReaderSubscription(subscription, contact, newsletter).supported, true);
	for (const changed of [{ customer: "cus_other" }, { id: "sub_other" }, { metadata: { ...subscription.metadata, kind: "group_subscription" } }, { metadata: { ...subscription.metadata, accountId: "f".repeat(24) } }]) assert.equal(readReaderSubscription({ ...subscription, ...changed }, contact, newsletter).owned, false);
	assert.equal(readReaderSubscription(subscription, { ...contact, accountId: "f".repeat(24) }, newsletter).owned, false);
});
test("an explicit canonical null, a group source and a lifetime payment never become a personal recurring subscription", () => {
	assert.equal(readerPersonalSubscriptionId({ ...contact, paidPersonal: null }), null);
	assert.equal(readerPersonalSubscriptionId({ ...contact, paidPersonal: { kind: "lifetime" } }), null);
	assert.equal(readerPersonalSubscriptionId({ stripeSubscriptionId: "sub_group", paidSource: "group" }), null);
	assert.equal(readerPersonalSubscriptionId({ stripeSubscriptionId: "sub_legacy" }), "sub_legacy");
});
test("only a current fixed licensed recurring item is supported; mixed or metered items are refused", () => {
	for (const change of [{ quantity: 2 }, { price: { ...subscription.items.data[0].price, unit_amount: null } }, { price: { ...subscription.items.data[0].price, recurring: { interval: "month", usage_type: "metered" } } }]) assert.equal(readReaderSubscription({ ...subscription, items: { data: [{ ...subscription.items.data[0], ...change }] } }, contact, newsletter).supported, false);
	assert.equal(readReaderSubscription({ ...subscription, items: { data: [...subscription.items.data, ...subscription.items.data] } }, contact, newsletter).supported, false);
});
test("true pause refuses classic billing, paused collection, cancellations, stale periods and foreign schedules", () => {
	const details = readReaderSubscription(subscription, contact, newsletter);
	assert.equal(getReaderPauseProblem(subscription, details, { now }), null);
	for (const change of [{ billing_mode: { type: "classic" } }, { pause_collection: { behavior: "void" } }, { status: "trialing" }, { cancel_at_period_end: true }, { pending_update: {} }]) assert.ok(getReaderPauseProblem({ ...subscription, ...change }, details, { now }));
	const scheduled = { ...subscription, schedule: "sub_sched_foreign" }; assert.match(getReaderPauseProblem(scheduled, readReaderSubscription(scheduled, contact, newsletter), { now }), /another schedule/);
	assert.ok(getReaderPauseProblem(subscription, { ...details, periodEnd: Math.floor(now / 1000) + 30 }, { now }));
});
test("one, three and six month pauses start at the paid period end and resume only on payment success", () => {
	const details = readReaderSubscription(subscription, contact, newsletter);
	for (const months of [1, 3, 6]) {
		const params = readerPauseScheduleParams(subscription, details, months), pause = params.pause_schedules[0];
		assert.equal(params.from_subscription, "sub_reader"); assert.equal(pause.pause.pause_at.timestamp, end);
		assert.deepEqual(pause.resume.resume_at, { type: "duration", duration: { interval: "month", interval_count: months } });
		assert.equal(pause.resume.settings.payment_behavior, "resume_on_payment_success"); assert.equal(pause.resume.settings.proration_behavior, "none"); assert.equal(pause.pause.settings.invoicing_behavior, "pending_invoice_item");
		assert.equal("pause_collection" in params, false); assert.equal("billing_mode" in params, false); assert.equal("phases" in params, false);
	}
	assert.throws(() => readerPauseScheduleParams(subscription, details, 2));
});
test("the cancellation survey is optional and sharing a reason requires explicit consent", () => {
	assert.deepEqual(readCancellationResponse({}), { response: null });
	assert.ok(readCancellationResponse({ reason: "cost" }).problem);
	assert.deepEqual(readCancellationResponse({ reason: "temporary", comment: "Away for a while", shareWithCreator: true }), { response: { reason: "temporary", comment: "Away for a while" } });
	assert.ok(readCancellationResponse({ reason: "invented", shareWithCreator: true }).problem);
	assert.ok(readCancellationResponse({ comment: "a".repeat(1001), shareWithCreator: true }).problem);
});
