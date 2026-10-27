import "server-only";
import { createHash } from "node:crypto";
import { scoped } from "@/lib/account-scope";
import { actionError } from "@/lib/actions/errors";
import { isDeletionPending } from "@/lib/account-state";
import { connectDb } from "@/lib/db";
import { currencyCode, minorAmount, normalizeSubscriptionFinancial } from "@/lib/subscription-revenue-rules";
import { getNewsletterTiers } from "@/lib/tier-rules";
import SubscriptionFinancial from "@/models/SubscriptionFinancial";
import SubscriptionChange from "@/models/SubscriptionChange";
import SubscriptionInvoice from "@/models/SubscriptionInvoice";
import Account from "@/models/Account";

const objectId = (value) => typeof value === "string" ? value : value?.id;
const providerEventId = (event) => /^evt_[A-Za-z0-9_]{1,96}$/.test(event?.id ?? "") ? event.id : null;
export const invoiceSubscriptionId = (invoice) => objectId(invoice?.subscription ?? invoice?.parent?.subscription_details?.subscription);

async function canRecord(account) {
	const current = await Account.findById(scoped(account).accountId).select("deletion").lean();
	return Boolean(current) && !isDeletionPending(current);
}

export async function flushFinancialChanges(row) {
	const pending = row.pendingChanges ?? [];
	if (!pending.length) return;
	try {
		await SubscriptionChange.insertMany(pending.map((change) => ({ ...change, accountId: row.accountId, newsletterId: row.newsletterId, subscriptionId: row.subscriptionId })), { ordered: false });
	} catch (error) {
		if (error?.code !== 11000) throw error;
		const count = await SubscriptionChange.countDocuments(scoped(row.accountId, { eventKey: { $in: pending.map((change) => change.eventKey) } }));
		if (count !== pending.length) throw error;
	}
	// A concurrent observation keeps its own outbox; a later retry deduplicates any already materialized changes.
	await SubscriptionFinancial.updateOne(scoped(row.accountId, { _id: row._id, revision: row.revision }), { $set: { pendingChanges: [] } });
}

export async function observeSubscriptionFinancial({ account, newsletter, subscription, source = "webhook", event = null, observedAt = new Date() }) {
	if (!/^sub_[A-Za-z0-9_]{1,96}$/.test(subscription?.id ?? "")) return { recorded: false };
	await connectDb();
	if (!await canRecord(account)) return { recorded: false };
	const accountId = scoped(account).accountId;
	if (String(newsletter.accountId) !== String(accountId)) throw actionError("not_found", "Newsletter not found");
	const state = normalizeSubscriptionFinancial(subscription, { tierIds: getNewsletterTiers(newsletter).map((tier) => tier.id), now: +observedAt });
	const filter = scoped(account, { subscriptionId: subscription.id });
	for (let attempt = 0; attempt < 8; attempt++) {
		const before = await SubscriptionFinancial.findOne(filter).lean();
		if (before && String(before.newsletterId) !== String(newsletter._id)) throw actionError("conflict", "This subscription is already recorded for another newsletter");
		if (before) {
			await flushFinancialChanges(before);
			if (+observedAt <= +new Date(before.observedAt)) return { recorded: true, changed: false };
		}
		const changed = !before || JSON.stringify(before.state) !== JSON.stringify(state);
		const revision = (before?.revision ?? 0) + 1;
		const change = changed ? { eventKey: createHash("sha256").update(`${subscription.id}:${revision}`).digest("hex"), before: before?.state ?? null, after: state, at: observedAt.toISOString(), source, providerEventId: providerEventId(event) } : null;
		const set = { state, revision, observedAt, source, pendingChanges: change ? [change] : [] };
		let written;
		if (!before) {
			try { written = (await SubscriptionFinancial.create({ ...set, accountId, newsletterId: newsletter._id, subscriptionId: subscription.id, firstObservedAt: observedAt })).toObject(); }
			catch (error) { if (error?.code === 11000) continue; throw error; }
		} else {
			written = await SubscriptionFinancial.findOneAndUpdate(scoped(account, { _id: before._id, revision: before.revision }), { $set: set }, { new: true }).lean();
			if (!written) continue;
		}
		await flushFinancialChanges(written);
		return { recorded: true, changed };
	}
	throw actionError("conflict", "The subscription report changed; refresh it again");
}

export async function observeSubscriptionInvoice({ account, newsletter, subscriptionId, invoice, source = "webhook", event = null, observedAt = new Date() }) {
	if (!/^in_[A-Za-z0-9_]{1,96}$/.test(invoice?.id ?? "") || invoiceSubscriptionId(invoice) !== subscriptionId || !(invoice.status === "paid" || invoice.paid === true) || !currencyCode(invoice.currency) || !minorAmount(invoice.amount_paid) || !Number.isFinite(invoice.status_transitions?.paid_at)) return { recorded: false };
	if (String(newsletter.accountId) !== String(scoped(account).accountId)) throw actionError("not_found", "Newsletter not found");
	if (!await canRecord(account)) return { recorded: false };
	const paidAt = new Date(invoice.status_transitions.paid_at * 1000);
	if (!Number.isFinite(+paidAt)) return { recorded: false };
	const sourceAt = source === "refresh" ? observedAt : Number.isFinite(event?.created) ? new Date(event.created * 1000) : paidAt;
	if (!Number.isFinite(+sourceAt)) return { recorded: false };
	const data = {
		newsletterId: newsletter._id, subscriptionId, invoiceId: invoice.id, currency: invoice.currency,
		amountPaidMinor: invoice.amount_paid, paidAt, observedAt, sourceAt, source, providerEventId: providerEventId(event),
		totalExTaxMinor: Number.isSafeInteger(invoice.total_excluding_tax) ? invoice.total_excluding_tax : null,
		postPaymentCreditsMinor: minorAmount(invoice.post_payment_credit_notes_amount) ? invoice.post_payment_credit_notes_amount : null,
		paidOutOfBand: typeof invoice.paid_out_of_band === "boolean" ? invoice.paid_out_of_band : null,
	};
	const filter = scoped(account, { invoiceId: invoice.id });
	for (let attempt = 0; attempt < 8; attempt++) {
		const current = await SubscriptionInvoice.findOne(filter).lean();
		if (current) {
			if (String(current.newsletterId) !== String(newsletter._id) || current.subscriptionId !== subscriptionId || current.currency !== invoice.currency) throw actionError("conflict", "This invoice belongs to another subscription");
			if (+sourceAt <= +new Date(current.sourceAt)) return { recorded: true, changed: false };
			if (data.amountPaidMinor < current.amountPaidMinor) return { recorded: true, changed: false };
			const { matchedCount } = await SubscriptionInvoice.updateOne(scoped(account, { _id: current._id, revision: current.revision }), { $set: { ...data, revision: current.revision + 1 } });
			if (matchedCount) return { recorded: true, changed: true };
		} else {
			try { await SubscriptionInvoice.create({ ...data, accountId: scoped(account).accountId }); return { recorded: true, changed: true }; }
			catch (error) { if (error?.code !== 11000) throw error; }
		}
	}
	throw actionError("conflict", "The invoice report changed; refresh it again");
}

// Membership still works if reporting is unavailable. An explicit financial refresh can repair its current snapshot.
export async function captureSubscriptionFinancial(context) {
	try {
		await observeSubscriptionFinancial(context);
		if (context.invoice) await observeSubscriptionInvoice({ ...context, invoice: context.invoice, subscriptionId: context.subscription.id });
	} catch { console.error(`[subscription-revenue] Observation unavailable for account ${context.account._id}, subscription ${context.subscription.id}`); }
}
