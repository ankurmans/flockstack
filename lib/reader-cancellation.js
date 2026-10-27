import "server-only";
import { scoped } from "@/lib/account-scope";
import { actionError } from "@/lib/actions/errors";
import { releaseOwnedReaderPauseSchedule } from "@/lib/reader-pause";
import { readCancellationResponse } from "@/lib/reader-retention-rules";
import { assertReaderRetentionWrite, claimReaderRetention, finishReaderRetention, readCurrentReaderBilling, readerRetentionStripeRequest } from "@/lib/reader-retention-store";
import CancellationResponse from "@/models/CancellationResponse";
import Contact from "@/models/Contact";

const conflict = message => actionError("conflict", message);
const ref = value => typeof value === "string" ? value : value?.id ?? null;
function isCanceled(subscription, details) {
	return ["canceled", "incomplete_expired"].includes(subscription.status) || subscription.cancel_at_period_end === true || Number.isSafeInteger(subscription.cancel_at) && subscription.cancel_at > 0 && (!details.periodEnd || subscription.cancel_at <= details.periodEnd);
}

async function keepResponse(context, claimed, input) {
	const filter = scoped(context.account, { retentionId: claimed.record._id, externalId: claimed.record.pending.externalId });
	let response = await CancellationResponse.findOne(filter).lean();
	if (!response) {
		if (!context.newsletter.readerRetention?.surveyEnabled) return null;
		const checked = readCancellationResponse(input);
		if (checked.problem) throw actionError("validation_failed", checked.problem);
		if (!checked.response) return null;
		try { response = (await CancellationResponse.create({ ...filter, newsletterId: context.newsletter._id, contactId: context.contact._id, ...checked.response, sharedAt: new Date() })).toObject(); }
		catch (error) { if (error?.code !== 11000) throw error; response = await CancellationResponse.findOne(filter).lean(); }
	}
	if (!await Contact.exists(scoped(context.account, { _id: context.contact._id, newsletterId: context.newsletter._id }))) {
		await CancellationResponse.deleteMany(filter);
		throw actionError("not_found", "Reader no longer available");
	}
	return response;
}

export async function cancelReaderSubscription({ account, newsletterId, contactId, externalId, confirm = false, response: input = {} }) {
	if (confirm !== true) throw actionError("validation_failed", "Confirm cancellation of this personal subscription. It doesn't issue a refund or unsubscribe you.");
	let context = await readCurrentReaderBilling({ account, newsletterId, contactId });
	if (!context.details.supported) throw conflict(context.details.problem);
	const retry = context.record?.pending?.kind === "cancel" && context.record.pending.externalId === externalId;
	const duplicate = context.record?.lastKind === "cancel" && context.record.lastExternalId === externalId;
	if (isCanceled(context.subscription, context.details) && !retry && !duplicate) return { context, record: context.record, duplicate: true, responseRecorded: false };
	if (context.newsletter.readerRetention?.surveyEnabled && !retry && !duplicate) {
		const checked = readCancellationResponse(input);
		if (checked.problem) throw actionError("validation_failed", checked.problem);
	}
	if (context.details.scheduleId && context.details.scheduleId !== context.record?.stripeScheduleId) throw conflict("This subscription has another schedule. Cancel it through Stripe; FlockStack won't take over that schedule.");
	const claimed = await claimReaderRetention(context, { kind: "cancel", externalId, request: { confirm: true }, params: { cancel_at_period_end: true, proration_behavior: "none" } });
	if (claimed.duplicate) return { context, record: claimed.record, duplicate: true, responseRecorded: Boolean(await CancellationResponse.exists(scoped(context.account, { retentionId: claimed.record._id, externalId }))) };
	const response = await keepResponse(context, claimed, input);
	if (!isCanceled(context.subscription, context.details)) {
		if (context.details.scheduleId) context = await releaseOwnedReaderPauseSchedule(context, claimed, { cancelFutureBilling: true });
		await assertReaderRetentionWrite(context, claimed);
		const immediate = ["paused", "unpaid", "incomplete"].includes(context.subscription.status);
		if (!immediate && !["active", "trialing", "past_due"].includes(context.subscription.status)) throw conflict("Refresh this subscription's current state before canceling");
		const current = await readerRetentionStripeRequest(context.account, `/v1/subscriptions/${context.subscription.id}`, {
			method: immediate ? "DELETE" : "POST", idempotencyKey: `flockstack-reader-cancel-${claimed.record._id}-${externalId}-${immediate ? "now" : "period-end"}`,
			params: immediate ? { invoice_now: false, prorate: false } : claimed.record.pending.params,
		});
		if (current?.id !== context.subscription.id || ref(current.customer) !== context.details.customerId) throw conflict("Stripe returned another reader's cancellation");
	}
	context = await readCurrentReaderBilling({ account: context.account, newsletterId, contactId });
	if (!isCanceled(context.subscription, context.details)) throw conflict("Stripe hasn't confirmed cancellation. Refresh billing before trying again.");
	const record = await finishReaderRetention(context.account, claimed, { cancellationRequestedAt: new Date(), observedSubscriptionStatus: context.subscription.status, ...(context.subscription.status === "canceled" && { pauseState: "ended" }) });
	if (response) await CancellationResponse.updateOne(scoped(context.account, { _id: response._id, contactId: context.contact._id }), { $set: { cancellationConfirmedAt: new Date() } });
	return { context, record, duplicate: false, responseRecorded: Boolean(response) };
}
