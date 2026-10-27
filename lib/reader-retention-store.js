import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { scoped } from "@/lib/account-scope";
import { isDeletionPending } from "@/lib/account-state";
import { actionError } from "@/lib/actions/errors";
import { getChargeAccount } from "@/lib/payments/connect";
import { getPaymentsMode } from "@/lib/payments/config";
import { StripeError, stripeRequest } from "@/lib/payments/stripe-api";
import { syncObservedPersonalSubscription } from "@/lib/payments/subscriptions";
import { readerPersonalSubscriptionId, readReaderSubscription, READER_RETENTION_VERSION } from "@/lib/reader-retention-rules";
import { isObjectIdString } from "@/lib/validation";
import Account from "@/models/Account";
import Contact from "@/models/Contact";
import Newsletter from "@/models/Newsletter";
import ReaderRetention from "@/models/ReaderRetention";

const conflict = message => actionError("conflict", message);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export const retentionChargeAccount = account => getChargeAccount(account) ?? "direct";

export async function readerRetentionStripeRequest(account, path, options = {}) {
	try { return await stripeRequest(path, { ...options, account: getChargeAccount(account), apiVersion: READER_RETENTION_VERSION }); }
	catch (error) {
		if (error instanceof StripeError || ["TimeoutError", "AbortError"].includes(error?.name) || error instanceof TypeError && /fetch/i.test(error.message)) throw actionError("unavailable", "Stripe couldn't confirm this billing change. Refresh its current state before retrying.");
		throw error;
	}
}

export async function readCurrentReaderBilling({ account, newsletterId, contactId }) {
	account = await Account.findById(account?._id ?? account).lean();
	if (!account || isDeletionPending(account)) throw actionError("not_found", "Reader billing is no longer available");
	if (getPaymentsMode() === "none" || getPaymentsMode() === "connect" && !getChargeAccount(account)) throw conflict("The creator's Stripe account isn't connected");
	const newsletter = isObjectIdString(String(newsletterId)) ? await Newsletter.findOne(scoped(account, { _id: newsletterId })).lean() : null;
	let contact = newsletter && isObjectIdString(String(contactId)) ? await Contact.findOne(scoped(account, { _id: contactId, newsletterId: newsletter._id })).lean() : null;
	if (!contact) throw actionError("not_found", "Reader not found");
	const subscriptionId = readerPersonalSubscriptionId(contact);
	if (!subscriptionId) throw conflict("This reader has no personal recurring subscription to manage. Gifts and group seats are separate.");
	const sourceGuard = Object.hasOwn(contact, "paidPersonal") ? { "paidPersonal.kind": "stripe", "paidPersonal.subscriptionId": subscriptionId } : { stripeSubscriptionId: subscriptionId, paidPersonal: { $exists: false } };
	const lease = randomUUID();
	const claimed = await Contact.updateOne(scoped(account, { _id: contact._id, newsletterId: newsletter._id, stripeCustomerId: contact.stripeCustomerId, ...sourceGuard }), { $set: { paidPersonalLease: lease } });
	if (!claimed.matchedCount) throw conflict("The reader's personal billing changed. Refresh before continuing.");
	const observedAt = new Date();
	const subscription = await readerRetentionStripeRequest(account, `/v1/subscriptions/${subscriptionId}`, { params: { expand: ["discounts.source.coupon", "items.data.discounts.source.coupon", "latest_invoice"] } });
	const details = readReaderSubscription(subscription, contact, newsletter);
	if (!details.owned) throw conflict(details.problem);
	await syncObservedPersonalSubscription({ account, contactId: contact._id, subscription, lease, observedAt });
	contact = await Contact.findOne(scoped(account, { _id: contact._id, newsletterId: newsletter._id, paidPersonalLease: lease })).lean();
	if (!contact || readerPersonalSubscriptionId(contact) !== subscriptionId) throw conflict("A newer reader billing observation won. Refresh before continuing.");
	const record = await ReaderRetention.findOne(scoped(account, { newsletterId: newsletter._id, subscriptionId })).lean();
	if (record?.contactId && String(record.contactId) !== String(contact._id)) throw conflict("This subscription's billing record belongs to another reader");
	if (record && record.chargeAccount !== retentionChargeAccount(account)) throw conflict("The creator's Stripe account changed. Review the original subscription in Stripe.");
	return { account, newsletter, contact, subscription, details, record, observedAt };
}

export async function ensureReaderRetention(context) {
	const { account, newsletter, contact, subscription } = context;
	const filter = scoped(account, { subscriptionId: subscription.id });
	let record = context.record;
	if (!record) {
		try { record = (await ReaderRetention.create({ ...filter, contactId: contact._id, newsletterId: newsletter._id, chargeAccount: retentionChargeAccount(account) })).toObject(); }
		catch (error) { if (error?.code !== 11000) throw error; record = await ReaderRetention.findOne(filter).lean(); }
	}
	if (!record || String(record.newsletterId) !== String(newsletter._id) || record.chargeAccount !== retentionChargeAccount(account) || record.contactId && String(record.contactId) !== String(contact._id)) throw conflict("This subscription's billing record changed");
	if (!await Contact.exists(scoped(account, { _id: contact._id, newsletterId: newsletter._id }))) {
		await ReaderRetention.updateOne(scoped(account, { _id: record._id, contactId: contact._id }), { $unset: { contactId: 1, lease: 1 }, $inc: { revision: 1 } });
		throw actionError("not_found", "Reader no longer available");
	}
	if (!record.contactId) {
		record = await ReaderRetention.findOneAndUpdate(scoped(account, { _id: record._id, contactId: null, revision: record.revision }), { $set: { contactId: contact._id }, $inc: { revision: 1 } }, { new: true }).lean();
		if (!record) throw conflict("This subscription's reader binding changed");
	}
	return record;
}

export async function claimReaderRetention(context, { kind, externalId, request, params, extra = {} }) {
	if (!uuid.test(externalId ?? "")) throw actionError("validation_failed", "Use a stable billing change UUID for every retry");
	const hash = createHash("sha256").update(JSON.stringify({ kind, request })).digest("hex");
	const record = await ensureReaderRetention(context);
	for (let attempt = 0; attempt < 8; attempt++) {
		const current = await ReaderRetention.findOne(scoped(context.account, { _id: record._id })).lean();
		if (!current) throw actionError("not_found", "Reader billing record not found");
		if (String(current.contactId) !== String(context.contact._id)) throw conflict("The reader's billing binding changed before this request");
		if (current.lastExternalId === externalId) {
			if (current.lastKind !== kind || current.lastRequestHash !== hash) throw conflict("This retry ID belongs to another billing change");
			return { record: current, duplicate: true };
		}
		if (current.pending?.externalId && (current.pending.externalId !== externalId || current.pending.kind !== kind || current.pending.requestHash !== hash)) throw conflict("An earlier billing change is awaiting confirmation. Refresh and retry that same change first.");
		const lease = randomUUID();
		const pending = current.pending?.externalId ? current.pending : { kind, externalId, requestHash: hash, request, startedAt: new Date(), params, ...extra };
		const saved = await ReaderRetention.findOneAndUpdate(scoped(context.account, { _id: current._id, revision: current.revision }), { $set: { lease, pending }, $inc: { revision: 1 } }, { new: true }).lean();
		if (saved) return { record: saved, lease, duplicate: false };
	}
	throw conflict("Reader billing changed. Refresh before continuing.");
}

export async function finishReaderRetention(account, claimed, values) {
	const { record, lease } = claimed;
	const saved = await ReaderRetention.findOneAndUpdate(scoped(account, { _id: record._id, lease, "pending.externalId": record.pending.externalId }), { $set: { ...values, lastExternalId: record.pending.externalId, lastKind: record.pending.kind, lastRequestHash: record.pending.requestHash, observedAt: new Date() }, $unset: { pending: 1, lease: 1 }, $inc: { revision: 1 } }, { new: true }).lean();
	if (!saved) throw conflict("A newer reader billing request won. Refresh its current state before retrying.");
	return saved;
}

export async function assertReaderRetentionWrite(context, claimed, { requirePauseEnabled = false, requireOfferId = null } = {}) {
	const [account, newsletter, contact, record] = await Promise.all([
		Account.findById(context.account._id).lean(),
		Newsletter.findOne(scoped(context.account, { _id: context.newsletter._id })).lean(),
		Contact.findOne(scoped(context.account, { _id: context.contact._id, newsletterId: context.newsletter._id, paidPersonalLease: context.contact.paidPersonalLease })).lean(),
		ReaderRetention.findOne(scoped(context.account, { _id: claimed.record._id, lease: claimed.lease, contactId: context.contact._id, "pending.externalId": claimed.record.pending.externalId })).lean(),
	]);
	if (!account || isDeletionPending(account) || !newsletter || !contact || !record || readerPersonalSubscriptionId(contact) !== context.subscription.id || contact.stripeCustomerId !== context.details.customerId || retentionChargeAccount(account) !== record.chargeAccount) throw conflict("The reader, account or billing request changed before this operation. Refresh before continuing.");
	if (["resume", "save"].includes(record.pending?.kind) && contact.status !== "active") throw conflict("This address is no longer subscribed. This billing change cannot continue; manage existing billing in Stripe.");
	if (requirePauseEnabled && !newsletter.readerRetention?.pauseEnabled) throw conflict("The creator closed new reader pauses before this operation");
	if (requireOfferId && String(newsletter.readerRetention?.saveOfferId) !== String(requireOfferId)) throw conflict("The creator withdrew or changed this save offer");
}

export function assertKnownRetentionCreation(record) {
	if (!record.pending?.startedAt || Date.now() - +new Date(record.pending.startedAt) > 23 * 3600000) throw conflict("An earlier billing creation has an unknown outcome older than 23 hours. The creator must review it in Stripe before trying again.");
}
