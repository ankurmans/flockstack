import "server-only";
import { scoped } from "@/lib/account-scope";
import { isDeletionPending } from "@/lib/account-state";
import { refreshSponsorshipInvoice } from "@/lib/sponsorship-billing";
import SponsorshipBooking from "@/models/SponsorshipBooking";

export const SPONSORSHIP_INVOICE_EVENTS = ["invoice.paid", "invoice.payment_failed", "invoice.finalized", "invoice.voided", "invoice.marked_uncollectible", "invoice.updated"];
const invoiceId = object => object?.object === "invoice" && /^in_[A-Za-z0-9_]{1,160}$/.test(object.id ?? "") ? object.id : null;

export async function isSponsorshipPayment(account, object) {
	const id = invoiceId(object);
	return Boolean(id && (object.metadata?.kind === "sponsorship" || await SponsorshipBooking.exists(scoped(account, { stripeInvoiceId: id }))));
}

export async function handleSponsorshipPayment({ account, object }) {
	if (isDeletionPending(account)) return { ignored: "account awaiting deletion" };
	const id = invoiceId(object);
	const booking = id ? await SponsorshipBooking.findOne(scoped(account, { stripeInvoiceId: id })).select("_id").lean() : null;
	if (!booking) return { ignored: "unknown sponsorship invoice" };
	const current = await refreshSponsorshipInvoice({ account, bookingId: booking._id });
	return { sponsorshipId: String(current._id), status: current.status, invoiceStatus: current.invoice?.status ?? null };
}

export async function findSponsorshipInvoiceAccountId(object) {
	const id = invoiceId(object);
	if (!id) return null;
	const booking = await SponsorshipBooking.findOne({ stripeInvoiceId: id }).select("accountId").setOptions({ crossAccount: true }).lean();
	return booking?.accountId ?? null;
}
