import "server-only";
import { createHash } from "node:crypto";
import { scoped } from "@/lib/account-scope";
import { actionError } from "@/lib/actions/errors";
import { getReaderPauseProblem, readerPauseScheduleParams } from "@/lib/reader-retention-rules";
import { assertKnownRetentionCreation, assertReaderRetentionWrite, claimReaderRetention, finishReaderRetention, readCurrentReaderBilling, readerRetentionStripeRequest } from "@/lib/reader-retention-store";
import ReaderRetention from "@/models/ReaderRetention";

const ref = value => typeof value === "string" ? value : value?.id ?? null;
const conflict = message => actionError("conflict", message);
const scheduleId = value => /^sub_sched_[A-Za-z0-9_]{1,160}$/.test(value ?? "");
const epoch = value => Number.isSafeInteger(value) && value > 0 && Number.isFinite(+new Date(value * 1000)) ? new Date(value * 1000) : null;
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
function scheduleTermsHash(schedule) {
	return Array.isArray(schedule.phases) && schedule.phases.length === 1 ? createHash("sha256").update(JSON.stringify(sorted({ phases: schedule.phases, defaultSettings: schedule.default_settings ?? null, endBehavior: schedule.end_behavior }))).digest("hex") : null;
}

function metadataFor(context, record) {
	return { flockstack: "1", kind: "reader_pause", accountId: String(context.account._id), newsletterId: String(context.newsletter._id), contactId: String(context.contact._id), retentionId: String(record._id) };
}

function sameMetadata(context, record, metadata) {
	return Object.entries(metadataFor(context, record)).every(([key, value]) => metadata?.[key] === value);
}

function checkSchedule(context, record, schedule, { initial = false } = {}) {
	if (!scheduleId(schedule?.id) || !initial && record.stripeScheduleId && schedule.id !== record.stripeScheduleId || ref(schedule.customer) !== context.details.customerId || ref(schedule.subscription) !== context.subscription.id || !initial && !sameMetadata(context, record, schedule.metadata)) throw conflict("Stripe returned a schedule that isn't owned by this reader billing flow");
	if (!Array.isArray(schedule.pause_schedules) || schedule.pause_schedules.length !== 1) throw conflict("The reader's pause schedule changed. Review it before continuing.");
	const entry = schedule.pause_schedules[0];
	if (typeof entry.key !== "string" || !entry.key || entry.key.length > 200 || !epoch(entry.pause?.pause_at) || !epoch(entry.resume?.resume_at) || entry.resume.resume_at <= entry.pause.pause_at) throw conflict("Stripe didn't confirm a bounded pause and resume attempt");
	const resume = entry.resume.settings;
	if (resume?.payment_behavior !== "resume_on_payment_success" || resume.billing_cycle_anchor !== "resume_at" || resume.proration_behavior !== "none") throw conflict("The pause's resume payment settings changed. Review them in Stripe.");
	return entry;
}

async function saveKnownSchedule(context, claimed, id) {
	const result = await ReaderRetention.findOneAndUpdate(scoped(context.account, { _id: claimed.record._id, lease: claimed.lease, "pending.externalId": claimed.record.pending.externalId }), { $set: { stripeScheduleId: id, "pending.scheduleId": id }, $inc: { revision: 1 } }, { new: true }).lean();
	if (!result) throw conflict("A newer billing request won before the schedule identity was saved. Refresh before retrying.");
	claimed.record = result;
}

export async function scheduleReaderPause({ account, newsletterId, contactId, months, externalId }) {
	let context = await readCurrentReaderBilling({ account, newsletterId, contactId });
	const retry = context.record?.pending?.kind === "pause" && context.record.pending.externalId === externalId;
	const duplicate = context.record?.lastKind === "pause" && context.record.lastExternalId === externalId;
	if (!retry && !duplicate) {
		if (!context.newsletter.readerRetention?.pauseEnabled) throw conflict("The creator hasn't enabled reader pauses");
		const problem = getReaderPauseProblem(context.subscription, context.details);
		if (problem) throw conflict(problem);
	}
	let params;
	if (retry) params = context.record.pending.params;
	else if (!duplicate) params = readerPauseScheduleParams(context.subscription, context.details, months);
	const claimed = await claimReaderRetention(context, { kind: "pause", externalId, request: { months }, params, extra: { months } });
	if (claimed.duplicate) return { context, record: claimed.record, duplicate: true };
	let schedule;
	if (claimed.record.pending.scheduleId) {
		schedule = await readerRetentionStripeRequest(context.account, `/v1/subscription_schedules/${claimed.record.pending.scheduleId}`);
		if (schedule?.id !== claimed.record.pending.scheduleId) throw conflict("Stripe returned another schedule during pause recovery");
	} else {
		// A retry uses the original period and duration. An expired idempotency window cannot create a second schedule.
		assertKnownRetentionCreation(claimed.record);
		await assertReaderRetentionWrite(context, claimed, { requirePauseEnabled: true });
		schedule = await readerRetentionStripeRequest(context.account, "/v1/subscription_schedules", { method: "POST", idempotencyKey: `flockstack-reader-pause-${claimed.record._id}-${externalId}`, params: claimed.record.pending.params });
		checkSchedule(context, claimed.record, schedule, { initial: true });
		await saveKnownSchedule(context, claimed, schedule.id);
	}
	let entry = checkSchedule(context, claimed.record, schedule, { initial: true });
	const expectedPause = claimed.record.pending.params.pause_schedules?.[0]?.pause?.pause_at?.timestamp;
	if (entry.pause.pause_at !== expectedPause) throw conflict("The pause no longer starts at the confirmed paid period end");
	if (!sameMetadata(context, claimed.record, schedule.metadata)) {
		if (Object.entries(metadataFor(context, claimed.record)).some(([key, value]) => schedule.metadata?.[key] !== undefined && schedule.metadata[key] !== value)) throw conflict("This schedule now belongs to another billing flow");
		await assertReaderRetentionWrite(context, claimed);
		schedule = await readerRetentionStripeRequest(context.account, `/v1/subscription_schedules/${schedule.id}`, { method: "POST", idempotencyKey: `flockstack-reader-pause-meta-${claimed.record._id}-${externalId}`, params: { metadata: metadataFor(context, claimed.record) } });
		entry = checkSchedule(context, claimed.record, schedule);
	}
	context = await readCurrentReaderBilling({ account: context.account, newsletterId, contactId });
	if (context.details.scheduleId !== schedule.id || !["active", "paused"].includes(context.subscription.status)) throw conflict("The subscription changed before its pause was confirmed. Refresh billing.");
	const record = await finishReaderRetention(context.account, claimed, { stripeScheduleId: schedule.id, scheduleTermsHash: scheduleTermsHash(schedule), pauseKey: entry.key, pauseMonths: months, pauseAt: epoch(entry.pause.pause_at), resumeAt: epoch(entry.resume.resume_at), pauseState: context.subscription.status === "paused" ? "paused" : "scheduled", observedSubscriptionStatus: context.subscription.status });
	return { context, record, duplicate: false };
}

export async function readOwnedReaderPause(context, { requireAttached = true } = {}) {
	const record = context.record;
	if (!record?.stripeScheduleId || !record.pauseKey || !record.pauseAt || !record.resumeAt) throw conflict("This reader has no confirmed FlockStack pause to manage");
	if (context.details.scheduleId !== record.stripeScheduleId) {
		if (!requireAttached && !context.details.scheduleId) return { record, schedule: null, entry: null };
		throw conflict("The reader's subscription schedule changed. Manage it in Stripe.");
	}
	const schedule = await readerRetentionStripeRequest(context.account, `/v1/subscription_schedules/${record.stripeScheduleId}`);
	const entry = checkSchedule(context, record, schedule);
	if (entry.key !== record.pauseKey || +epoch(entry.pause.pause_at) !== +new Date(record.pauseAt)) throw conflict("The pause entry changed. Review it in Stripe before continuing.");
	return { record, schedule, entry };
}

export async function cancelScheduledReaderPause({ account, newsletterId, contactId, externalId }) {
	let context = await readCurrentReaderBilling({ account, newsletterId, contactId });
	const retry = context.record?.pending?.kind === "unpause" && context.record.pending.externalId === externalId;
	const duplicate = context.record?.lastKind === "unpause" && context.record.lastExternalId === externalId;
	if (!retry && !duplicate) {
		if (context.subscription.status !== "active" || +new Date(context.record?.pauseAt) <= Date.now()) throw conflict("This pause has started. Resume the paused subscription instead of canceling its future pause.");
		await readOwnedReaderPause(context);
	}
	const claimed = await claimReaderRetention(context, { kind: "unpause", externalId, request: {}, params: { pause_schedules: "" } });
	if (claimed.duplicate) return { context, record: claimed.record, duplicate: true };
	if (!context.details.scheduleId) {
		context = await releaseOwnedReaderPauseSchedule(context, claimed);
		const record = await finishReaderRetention(context.account, claimed, { pauseState: "ended", observedSubscriptionStatus: context.subscription.status });
		return { context, record, duplicate: false };
	}
	if (context.subscription.status !== "active" || context.details.scheduleId !== claimed.record.stripeScheduleId) throw conflict("The subscription or its schedule changed before the future pause could be removed");
	const before = await readerRetentionStripeRequest(context.account, `/v1/subscription_schedules/${claimed.record.stripeScheduleId}`);
	if (!sameMetadata(context, claimed.record, before.metadata) || ref(before.subscription) !== context.subscription.id || ref(before.customer) !== context.details.customerId || !Array.isArray(before.pause_schedules) || before.pause_schedules.length > 1 || before.pause_schedules.length === 1 && before.pause_schedules[0].key !== claimed.record.pauseKey) throw conflict("The schedule's pause entry changed before removal. Review it in Stripe.");
	await assertReaderRetentionWrite(context, claimed);
	const schedule = await readerRetentionStripeRequest(context.account, `/v1/subscription_schedules/${claimed.record.stripeScheduleId}`, { method: "POST", idempotencyKey: `flockstack-reader-unpause-${claimed.record._id}-${externalId}`, params: claimed.record.pending.params });
	if (!sameMetadata(context, claimed.record, schedule.metadata) || ref(schedule.subscription) !== context.subscription.id || ref(schedule.customer) !== context.details.customerId || !Array.isArray(schedule.pause_schedules) || schedule.pause_schedules.length) throw conflict("Stripe hasn't confirmed removal of this reader's scheduled pause");
	// Remove only the schedule this flow made, with its original one-phase terms unchanged. A creator's later phase
	// edits stay in Stripe: clearing this pause must never silently discard their future pricing or billing changes.
	if (claimed.record.scheduleTermsHash && scheduleTermsHash(schedule) === claimed.record.scheduleTermsHash) context = await releaseOwnedReaderPauseSchedule(context, claimed);
	context = await readCurrentReaderBilling({ account: context.account, newsletterId, contactId });
	if (context.subscription.status !== "active") throw conflict("The subscription paused during this change. Refresh billing before resuming.");
	const record = await finishReaderRetention(context.account, claimed, { pauseState: "ended", observedSubscriptionStatus: context.subscription.status });
	return { context, record, duplicate: false };
}

export async function releaseOwnedReaderPauseSchedule(context, claimed, { cancelFutureBilling = false } = {}) {
	const id = claimed.record.stripeScheduleId;
	if (!scheduleId(id) || context.details.scheduleId && context.details.scheduleId !== id) throw conflict("This subscription has another schedule. Review it in Stripe.");
	let schedule = await readerRetentionStripeRequest(context.account, `/v1/subscription_schedules/${id}`);
	const released = row => row?.id === id && row.status === "released" && ref(row.released_subscription) === context.subscription.id && ref(row.customer) === context.details.customerId && sameMetadata(context, claimed.record, row.metadata);
	if (released(schedule)) return readCurrentReaderBilling({ account: context.account, newsletterId: context.newsletter._id, contactId: context.contact._id });
	if (!sameMetadata(context, claimed.record, schedule.metadata) || ref(schedule.subscription) !== context.subscription.id || ref(schedule.customer) !== context.details.customerId || schedule.status !== "active") throw conflict("This schedule is no longer owned by the reader pause flow");
	if (!cancelFutureBilling && (!claimed.record.scheduleTermsHash || scheduleTermsHash(schedule) !== claimed.record.scheduleTermsHash)) throw conflict("The creator changed this schedule's billing terms. The pause can be removed without releasing those changes.");
	await assertReaderRetentionWrite(context, claimed);
	try { schedule = await readerRetentionStripeRequest(context.account, `/v1/subscription_schedules/${id}/release`, { method: "POST", idempotencyKey: `flockstack-reader-release-${claimed.record._id}-${claimed.record.pending.externalId}`, params: { preserve_cancel_date: true } }); }
	catch (error) {
		const current = await readerRetentionStripeRequest(context.account, `/v1/subscription_schedules/${id}`);
		if (!released(current)) throw error;
		schedule = current;
	}
	if (!released(schedule)) throw conflict("Stripe hasn't confirmed release of this reader's own pause schedule");
	return readCurrentReaderBilling({ account: context.account, newsletterId: context.newsletter._id, contactId: context.contact._id });
}

export async function resumeReaderSubscription({ account, newsletterId, contactId, externalId, confirmBilling = false }) {
	if (confirmBilling !== true) throw actionError("validation_failed", "Confirm that resuming starts billing again and may attempt payment");
	let context = await readCurrentReaderBilling({ account, newsletterId, contactId });
	if (context.contact.status !== "active") throw conflict("This address is no longer subscribed. Resuming billing doesn't subscribe it again; manage it in Stripe.");
	const retry = context.record?.pending?.kind === "resume" && context.record.pending.externalId === externalId;
	const duplicate = context.record?.lastKind === "resume" && context.record.lastExternalId === externalId;
	if (!retry && !duplicate) {
		if (!context.details.supported || context.subscription.status !== "paused" || context.subscription.billing_mode?.type !== "flexible" || context.subscription.collection_method !== "charge_automatically") throw conflict("Only this reader's supported paused subscription can resume");
		if (context.record?.pauseState === "resume_pending" && ["open", "draft"].includes(context.subscription.latest_invoice?.status)) throw conflict("A resume invoice is already awaiting payment. Complete it instead of starting another resume.");
		await readOwnedReaderPause(context, { requireAttached: false });
		const paused = context.subscription.status_details?.paused;
		if (paused?.subscription?.type !== "pause_requested" || +epoch(paused.transitioned_at) !== +new Date(context.record.pauseAt)) throw conflict("The subscription's pause no longer matches this reader's confirmed pause. Review it in Stripe.");
	}
	const claimed = await claimReaderRetention(context, { kind: "resume", externalId, request: { confirmBilling: true }, params: { billing_cycle_anchor: "now", proration_behavior: "none", payment_behavior: "resume_on_payment_success" } });
	if (claimed.duplicate) return { context, record: claimed.record, duplicate: true };
	let resumedAt = null;
	if (context.subscription.status === "paused") {
		assertKnownRetentionCreation(claimed.record);
		if (context.details.scheduleId) {
			const { entry, schedule } = await readOwnedReaderPause(context);
			await assertReaderRetentionWrite(context, claimed);
			const current = await readerRetentionStripeRequest(context.account, `/v1/subscription_schedules/${schedule.id}`, { method: "POST", idempotencyKey: `flockstack-reader-resume-${claimed.record._id}-${externalId}`, params: { pause_schedules: [{ key: entry.key, resume: { resume_at: { type: "now" }, settings: { billing_cycle_anchor: "resume_at", proration_behavior: "none", payment_behavior: "resume_on_payment_success" } } }] } });
			const next = checkSchedule(context, claimed.record, current);
			if (next.key !== claimed.record.pauseKey) throw conflict("The pause entry changed during its resume attempt");
			resumedAt = epoch(next.resume.resume_at);
		} else {
			if (!claimed.record.pauseAt) throw conflict("No confirmed reader pause is available to resume");
			const paused = context.subscription.status_details?.paused;
			if (paused?.subscription?.type !== "pause_requested" || +epoch(paused.transitioned_at) !== +new Date(claimed.record.pauseAt)) throw conflict("The subscription is paused for another reason");
			await assertReaderRetentionWrite(context, claimed);
			const current = await readerRetentionStripeRequest(context.account, `/v1/subscriptions/${context.subscription.id}/resume`, { method: "POST", idempotencyKey: `flockstack-reader-resume-${claimed.record._id}-${externalId}`, params: claimed.record.pending.params });
			if (current?.id !== context.subscription.id || ref(current.customer) !== context.details.customerId) throw conflict("Stripe returned another reader's subscription");
		}
	} else if (context.subscription.status !== "active") throw conflict("The subscription changed before resumption. Refresh its current billing state.");
	context = await readCurrentReaderBilling({ account: context.account, newsletterId, contactId });
	const record = await finishReaderRetention(context.account, claimed, { pauseState: context.subscription.status === "active" ? "ended" : "resume_pending", observedSubscriptionStatus: context.subscription.status, ...(resumedAt && { resumeAt: resumedAt }) });
	return { context, record, duplicate: false };
}
