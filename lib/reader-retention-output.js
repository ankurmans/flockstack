import "server-only";
import { getReaderPauseProblem } from "@/lib/reader-retention-rules";
import { readReaderSaveOffer } from "@/lib/reader-save-offer";
import { isPaidContact } from "@/lib/tiers";

const iso = value => value && Number.isFinite(+new Date(value)) ? new Date(value).toISOString() : null;
const epoch = value => Number.isSafeInteger(value) && value > 0 ? iso(value * 1000) : null;
const ref = value => typeof value === "string" ? value : value?.id ?? null;
const minor = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const stripeUrl = value => { try { const url = new URL(value); return url.protocol === "https:" && ["invoice.stripe.com", "pay.stripe.com"].includes(url.hostname) && !url.username && !url.password && !url.port ? url.href : null; } catch { return null; } };

export async function readerRetentionOutput(context, record = context.record) {
	const { newsletter, contact, subscription, details } = context;
	const pending = record?.pending?.externalId ? record.pending : null;
	const pauseProblem = getReaderPauseProblem(subscription, details);
	const matching = Boolean(record?.stripeScheduleId && details.scheduleId === record.stripeScheduleId);
	const paused = subscription.status_details?.paused;
	const ownPause = Boolean(record?.pauseAt && record.pauseKey && paused?.subscription?.type === "pause_requested" && epoch(paused.transitioned_at) === iso(record.pauseAt));
	const cancellationScheduled = subscription.cancel_at_period_end === true || Number.isSafeInteger(subscription.cancel_at) && subscription.cancel_at > 0;
	const canceled = ["canceled", "incomplete_expired"].includes(subscription.status);
	const invoice = subscription.latest_invoice;
	const ownInvoice = invoice && typeof invoice === "object" && ref(invoice.customer) === details.customerId && ref(invoice.subscription ?? invoice.parent?.subscription_details?.subscription) === subscription.id;
	let save;
	try { save = await readReaderSaveOffer({ ...context, record }); }
	catch (error) { if (!["unavailable", "conflict", "rate_limited"].includes(error.code)) throw error; save = { available: false, problem: "The save offer is temporarily unavailable", offer: null }; }
	const pauseState = subscription.status === "paused" && ownPause ? record?.pauseState === "resume_pending" ? "resume_pending" : "paused" : record?.pauseState === "ended" ? "ended" : record?.pauseAt && subscription.status === "active" ? +new Date(record.pauseAt) > Date.now() ? "scheduled" : "not_paused" : record?.pauseState ?? null;
	return {
		contactId: String(contact._id), newsletterId: String(newsletter._id), status: subscription.status,
		observedAt: iso(context.observedAt), personalPaidUntil: iso(contact.paidPersonal?.until), effectivePaid: isPaidContact(contact), effectivePaidSource: contact.paidSource ?? null,
		price: details.supported ? { amountMinor: details.unitAmountMinor, currency: details.currency, interval: details.interval } : null,
		pause: { enabled: newsletter.readerRetention?.pauseEnabled === true, state: pauseState, months: record?.pauseMonths ?? null, pauseAt: iso(record?.pauseAt), resumeAt: iso(record?.resumeAt), canSchedule: !pending && newsletter.readerRetention?.pauseEnabled === true && !pauseProblem, canCancelScheduled: !pending && matching && subscription.status === "active" && +new Date(record?.pauseAt) > Date.now() && record?.pauseState !== "ended", canResume: !pending && contact.status === "active" && subscription.status === "paused" && ownPause && (!details.scheduleId || matching) && !(record?.pauseState === "resume_pending" && ["open", "draft"].includes(ownInvoice ? invoice.status : null)), problem: pauseProblem ?? (newsletter.readerRetention?.pauseEnabled ? null : "The creator hasn't enabled reader pauses") },
		save: { available: !pending && save.available, problem: pending ? "An earlier billing change is awaiting confirmation" : save.problem, offer: save.offer, usedAt: iso(record?.saveUsedAt) },
		cancellation: { scheduled: cancellationScheduled, canceled, effectiveAt: epoch(subscription.cancel_at) ?? (subscription.cancel_at_period_end ? epoch(details.periodEnd) : null), requestedAt: iso(record?.cancellationRequestedAt), canCancel: !pending && details.supported && !canceled && !cancellationScheduled && (!details.scheduleId || matching), surveyEnabled: newsletter.readerRetention?.surveyEnabled === true },
		invoice: ownInvoice ? { status: invoice.status ?? null, currency: typeof invoice.currency === "string" ? invoice.currency : null, totalMinor: minor(invoice.total), amountPaidMinor: minor(invoice.amount_paid), amountDueMinor: minor(invoice.amount_due), hostedUrl: stripeUrl(invoice.hosted_invoice_url), pdfUrl: stripeUrl(invoice.invoice_pdf) } : null,
		pending: pending ? { kind: pending.kind, externalId: pending.externalId, startedAt: iso(pending.startedAt), request: { ...(pending.request?.months !== undefined && { months: pending.request.months }), ...(pending.request?.offerId && { offerId: pending.request.offerId }), ...(pending.request?.expectedHash && { expectedHash: pending.request.expectedHash }) } } : null,
	};
}
