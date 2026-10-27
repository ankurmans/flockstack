import "server-only";
import { randomUUID } from "node:crypto";
import { scoped } from "@/lib/account-scope";
import { actionError } from "@/lib/actions/errors";
import { assertPaymentsReady, getChargeAccount } from "@/lib/payments/connect";
import { StripeError, stripeRequest } from "@/lib/payments/stripe-api";
import { currentSponsorshipAccount } from "@/lib/sponsorship-bookings";
import { findSponsorshipRecord } from "@/lib/sponsorship-inventory";
import { readSponsorshipInvoice, SPONSOR_LIMITS } from "@/lib/sponsorship-rules";
import SponsorshipBooking from "@/models/SponsorshipBooking";
import SponsorshipSlot from "@/models/SponsorshipSlot";

const providerId = (value, prefix) => typeof value === "string" && new RegExp(`^${prefix}_[A-Za-z0-9_]{1,160}$`).test(value);
const reference = value => typeof value === "string" ? value : value?.id;
const conflict = message => actionError("conflict", message);
const metadataFor = booking => ({ flockstack: "1", kind: "sponsorship", accountId: String(booking.accountId), newsletterId: String(booking.newsletterId), bookingId: String(booking._id), slotId: String(booking.slotId) });
const sameMetadata = (booking, metadata) => Object.entries(metadataFor(booking)).every(([key, value]) => metadata?.[key] === value);
const invoiceUrl = value => {
	try { const url = new URL(value); return url.protocol === "https:" && ["invoice.stripe.com", "pay.stripe.com"].includes(url.hostname) && !url.username && !url.password ? url.href : null; } catch { return null; }
};

export async function sponsorshipStripeRequest(path, options) {
	try { return await stripeRequest(path, options); }
	catch (error) {
		if (error instanceof StripeError || ["TimeoutError", "AbortError"].includes(error?.name) || error instanceof TypeError && /fetch/i.test(error.message)) throw actionError("unavailable", "Stripe couldn't complete this sponsorship request. Retry later with the same booking.");
		throw error;
	}
}

function assertChargeAccount(account, booking) {
	assertPaymentsReady(account);
	if (booking.chargeAccount && booking.chargeAccount !== (getChargeAccount(account) ?? "direct")) throw conflict("The creator's Stripe account changed. This booking needs review before billing continues.");
}

async function saveInvoiceObservation(account, bookingId, lease, invoice) {
	const current = await SponsorshipBooking.findOne(scoped(account, { _id: bookingId, invoiceLease: lease })).lean();
	if (!current) throw conflict("A newer sponsorship billing request is in progress. Retry later.");
	const read = readSponsorshipInvoice(invoice, current);
	if (!read.owned) throw conflict(read.reason);
	const status = current.status === "canceled" ? "canceled" : read.funded ? "paid" : "invoiced";
	const saved = await SponsorshipBooking.findOneAndUpdate(scoped(account, { _id: current._id, invoiceLease: lease, status: current.status }), { $set: {
		status, invoiceFunded: current.status !== "canceled" && read.funded, invoiceObservedAt: new Date(), invoiceProblem: read.reason,
		invoice: { ...read.observed, hostedUrl: invoiceUrl(invoice.hosted_invoice_url), pdfUrl: invoiceUrl(invoice.invoice_pdf) },
	}, $inc: { revision: 1 } }, { new: true }).lean();
	if (!saved) throw conflict("The sponsorship changed while billing was read. Refresh it again.");
	return saved;
}

export async function refreshSponsorshipInvoice({ account, bookingId }) {
	account = await currentSponsorshipAccount(account);
	const booking = await findSponsorshipRecord(SponsorshipBooking, account, bookingId);
	assertChargeAccount(account, booking);
	if (!booking.stripeInvoiceId) throw conflict("This sponsorship has no recorded invoice yet");
	if (!providerId(booking.stripeInvoiceId, "in")) throw conflict("This sponsorship has an invalid invoice reference");
	const lease = randomUUID();
	const claimed = await SponsorshipBooking.updateOne(scoped(account, { _id: booking._id, stripeInvoiceId: booking.stripeInvoiceId }), { $set: { invoiceLease: lease } });
	if (!claimed.matchedCount) throw actionError("not_found", "Sponsorship booking not found");
	const invoice = await sponsorshipStripeRequest(`/v1/invoices/${booking.stripeInvoiceId}`, { account: getChargeAccount(account) });
	return saveInvoiceObservation(account, booking._id, lease, invoice);
}

// One explicit creator invoice per accepted booking. Each provider object has a stable retry identity and its ID is
// saved before the next step. Draft creation/finalization never attempts a saved-card charge or sends the invoice.
export async function createSponsorshipInvoice({ account, bookingId }) {
	account = await currentSponsorshipAccount(account, { change: true });
	let booking = await findSponsorshipRecord(SponsorshipBooking, account, bookingId);
	assertChargeAccount(account, booking);
	if (!booking.verifiedAt || booking.cancelingAt || !["accepted", "invoiced", "paid"].includes(booking.status)) throw conflict("Accept the sponsor's verified request before creating an invoice");
	for (const [field, prefix] of [["stripeInvoiceId", "in"], ["stripeInvoiceItemId", "ii"], ["stripeCustomerId", "cus"]]) if (booking[field] && !providerId(booking[field], prefix)) throw conflict("This booking has an invalid billing reference. Review it before continuing.");
	if (booking.stripeInvoiceId && booking.stripeInvoiceItemId) {
		const invoice = await sponsorshipStripeRequest(`/v1/invoices/${booking.stripeInvoiceId}`, { account: getChargeAccount(account) });
		const check = readSponsorshipInvoice(invoice, booking);
		if (!check.owned || !check.supported) throw conflict(check.reason);
		if (invoice.status === "draft") await sponsorshipStripeRequest(`/v1/invoices/${booking.stripeInvoiceId}/finalize`, { method: "POST", account: getChargeAccount(account), idempotencyKey: `flockstack-sponsor-finalize-${booking._id}`, params: { auto_advance: false } });
		return refreshSponsorshipInvoice({ account, bookingId });
	}
	const slot = await findSponsorshipRecord(SponsorshipSlot, account, booking.slotId);
	if (slot.status !== "reserved" || String(slot.bookingId) !== String(booking._id) || String(slot.newsletterId) !== String(booking.newsletterId) || slot.amountMinor !== booking.amountMinor || slot.currency !== booking.currency) throw conflict("This booking no longer owns its agreed placement date and price");
	if (booking.invoiceStartedAt && Date.now() - +new Date(booking.invoiceStartedAt) > 23 * 3600000) throw conflict("An earlier invoice attempt has an unknown outcome older than 23 hours. Review it in Stripe before trying again.");
	const lease = randomUUID();
	booking = await SponsorshipBooking.findOneAndUpdate(scoped(account, { _id: booking._id, status: "accepted" }), { $set: { invoiceLease: lease, invoiceStartedAt: booking.invoiceStartedAt ?? new Date(), chargeAccount: getChargeAccount(account) ?? "direct" }, $inc: { revision: 1 } }, { new: true }).lean();
	if (!booking) throw conflict("This sponsorship changed before invoice creation");
	const stripeAccount = getChargeAccount(account), metadata = metadataFor(booking);
	const call = (path, options = {}) => sponsorshipStripeRequest(path, { account: stripeAccount, ...options });
	async function persist(set) {
		const updated = await SponsorshipBooking.findOneAndUpdate(scoped(account, { _id: booking._id, invoiceLease: lease, status: "accepted" }), { $set: set, $inc: { revision: 1 } }, { new: true }).lean();
		if (!updated) throw conflict("This sponsorship changed during invoice creation. Review the existing Stripe objects before continuing.");
		booking = updated;
	}
	if (!booking.stripeCustomerId) {
		const customer = await call("/v1/customers", { method: "POST", idempotencyKey: `flockstack-sponsor-customer-${booking._id}`, params: { email: booking.email, name: booking.brandName, metadata } });
		if (!providerId(customer?.id, "cus") || !sameMetadata(booking, customer.metadata)) throw conflict("Stripe returned a customer for another sponsorship");
		await persist({ stripeCustomerId: customer.id });
	}
	if (!booking.stripeInvoiceId) {
		const invoice = await call("/v1/invoices", { method: "POST", idempotencyKey: `flockstack-sponsor-invoice-${booking._id}`, params: { customer: booking.stripeCustomerId, currency: booking.currency, collection_method: "send_invoice", days_until_due: SPONSOR_LIMITS.invoiceDays, auto_advance: false, pending_invoice_items_behavior: "exclude", metadata, description: `${booking.placementName}: planned ${booking.day} (${booking.timeZone}). A sponsorship request does not schedule or send an issue.` } });
		if (!providerId(invoice?.id, "in") || reference(invoice.customer) !== booking.stripeCustomerId || !sameMetadata(booking, invoice.metadata)) throw conflict("Stripe returned an invoice for another sponsorship");
		await persist({ stripeInvoiceId: invoice.id });
	}
	if (!booking.stripeInvoiceItemId) {
		const invoice = await call(`/v1/invoices/${booking.stripeInvoiceId}`);
		if (!sameMetadata(booking, invoice?.metadata) || reference(invoice.customer) !== booking.stripeCustomerId || invoice.status !== "draft" || invoice.lines?.has_more || !Array.isArray(invoice.lines?.data) || invoice.lines.data.length > 1) throw conflict("This invoice isn't an owned placement draft. Review it before adding a line.");
		const line = invoice.lines.data[0];
		const recoveredId = line && reference(line.invoice_item ?? line.parent?.invoice_item_details?.invoice_item);
		if (line && !providerId(recoveredId, "ii")) throw conflict("An earlier placement line can't be identified. Review this draft invoice.");
		const item = recoveredId ? await call(`/v1/invoiceitems/${recoveredId}`) : await call("/v1/invoiceitems", { method: "POST", idempotencyKey: `flockstack-sponsor-line-${booking._id}`, params: { customer: booking.stripeCustomerId, invoice: booking.stripeInvoiceId, amount: booking.amountMinor, currency: booking.currency, description: `${booking.placementName} — ${booking.day} (${booking.timeZone})`, metadata } });
		if (!providerId(item?.id, "ii") || reference(item.invoice) !== booking.stripeInvoiceId || reference(item.customer) !== booking.stripeCustomerId || item.amount !== booking.amountMinor || item.currency !== booking.currency || !sameMetadata(booking, item.metadata)) throw conflict("Stripe returned a placement line for another booking");
		await persist({ stripeInvoiceItemId: item.id });
	}
	const draft = await call(`/v1/invoices/${booking.stripeInvoiceId}`);
	const check = readSponsorshipInvoice(draft, booking);
	if (!check.owned || !check.supported) throw conflict(check.reason);
	if (draft.status === "draft") await call(`/v1/invoices/${booking.stripeInvoiceId}/finalize`, { method: "POST", idempotencyKey: `flockstack-sponsor-finalize-${booking._id}`, params: { auto_advance: false } });
	return refreshSponsorshipInvoice({ account, bookingId: booking._id });
}
