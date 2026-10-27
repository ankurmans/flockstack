import "server-only";
import { randomUUID } from "node:crypto";
import { scoped } from "@/lib/account-scope";
import { actionError } from "@/lib/actions/errors";
import { getChargeAccount } from "@/lib/payments/connect";
import { refreshSponsorshipInvoice, sponsorshipStripeRequest } from "@/lib/sponsorship-billing";
import { currentSponsorshipAccount } from "@/lib/sponsorship-bookings";
import { findSponsorshipRecord } from "@/lib/sponsorship-inventory";
import { readSponsorshipInvoice } from "@/lib/sponsorship-rules";
import SponsorshipBooking from "@/models/SponsorshipBooking";
import SponsorshipSlot from "@/models/SponsorshipSlot";

const conflict = message => actionError("conflict", message);

async function releaseSlot(account, booking) {
	await SponsorshipSlot.updateOne(scoped(account, { _id: booking.slotId, newsletterId: booking.newsletterId, status: "reserved", bookingId: booking._id }), { $set: { status: "open" }, $unset: { bookingId: 1 }, $inc: { revision: 1 } });
}

// Withdrawal of an unbilled request is separate from money. Once invoicing starts, only the creator can cancel it,
// and an open/draft invoice must actually be void before its date is offered to another buyer. No refund API is called.
export async function cancelSponsorship({ account, bookingId, acknowledgeNoRefund = false, managerVersion }) {
	account = await currentSponsorshipAccount(account);
	let booking = await findSponsorshipRecord(SponsorshipBooking, account, bookingId);
	if (managerVersion !== undefined && (!booking.verifiedAt || booking.managerVersion !== managerVersion)) throw actionError("not_found", "Sponsorship request not found");
	if (booking.status === "canceled") { await releaseSlot(account, booking); return booking; }
	if (booking.campaignId) throw conflict("Detach this sponsorship from its draft issue before canceling. Sent placements keep their delivery record; handle any owed refund in Stripe.");
	if (!booking.invoiceStartedAt && !booking.stripeInvoiceId) {
		const canceled = await SponsorshipBooking.findOneAndUpdate(scoped(account, { _id: booking._id, invoiceStartedAt: null, stripeInvoiceId: null, status: { $in: ["unverified", "requested", "accepted"] }, ...(managerVersion !== undefined && { managerVersion }) }), { $set: { status: "canceled", canceledAt: new Date(), invoiceLease: randomUUID() }, $unset: { cancelingAt: 1 }, $inc: { revision: 1, verificationVersion: 1 } }, { new: true }).lean();
		if (!canceled) throw conflict("Invoicing started or the request changed. Refresh before canceling.");
		await releaseSlot(account, canceled); return canceled;
	}
	if (managerVersion !== undefined) throw conflict("The creator must review cancellation once invoicing starts. No refund has been issued.");
	if (!booking.stripeInvoiceId) throw conflict("An invoice creation attempt has an unknown outcome. Recover it in Stripe before releasing this placement date.");
	booking = await refreshSponsorshipInvoice({ account, bookingId });
	if (booking.chargeAccount !== (getChargeAccount(account) ?? "direct")) throw conflict("The creator's Stripe account changed. Review the existing invoice before canceling.");
	if ((booking.invoice?.status === "paid" || (booking.invoice?.amountPaidMinor ?? 0) > 0) && !acknowledgeNoRefund) throw conflict("This invoice records a payment. Confirm that canceling won't issue a refund; handle any owed refund in Stripe.");
	const lease = randomUUID();
	const claimed = await SponsorshipBooking.findOneAndUpdate(scoped(account, { _id: booking._id, stripeInvoiceId: booking.stripeInvoiceId, status: booking.status }), { $set: { cancelingAt: new Date(), invoiceLease: lease }, $inc: { revision: 1 } }, { new: true }).lean();
	if (!claimed) throw conflict("This sponsorship changed before cancellation");
	const request = (path, options = {}) => sponsorshipStripeRequest(path, { account: getChargeAccount(account), ...options });
	let invoice = await request(`/v1/invoices/${booking.stripeInvoiceId}`);
	if (!readSponsorshipInvoice(invoice, booking).owned) throw conflict("Stripe returned another booking's invoice");
	if (invoice.status === "draft") throw conflict("Recover and finalize this draft invoice before canceling. Its placement date stays reserved until the finalized invoice is confirmed void.");
	if (["open", "uncollectible"].includes(invoice.status)) {
		try { invoice = await request(`/v1/invoices/${booking.stripeInvoiceId}/void`, { method: "POST", idempotencyKey: `flockstack-sponsor-void-${booking.stripeInvoiceId}` }); }
		catch (error) {
			const current = await request(`/v1/invoices/${booking.stripeInvoiceId}`);
			if (!readSponsorshipInvoice(current, booking).owned) throw conflict("Stripe returned another booking's invoice");
			if (!["paid", "void"].includes(current.status)) throw error;
			invoice = current;
		}
	}
	const read = readSponsorshipInvoice(invoice, booking);
	if (!read.owned || !["paid", "void"].includes(invoice.status)) throw conflict("The existing invoice hasn't been paid or confirmed void. Its placement date stays reserved.");
	if ((invoice.status === "paid" || (read.observed?.amountPaidMinor ?? 0) > 0) && !acknowledgeNoRefund) {
		await SponsorshipBooking.updateOne(scoped(account, { _id: booking._id, invoiceLease: lease }), { $unset: { cancelingAt: 1 } });
		await refreshSponsorshipInvoice({ account, bookingId });
		throw conflict("The invoice was paid during cancellation. Review any owed refund in Stripe before confirming cancellation.");
	}
	const canceled = await SponsorshipBooking.findOneAndUpdate(scoped(account, { _id: booking._id, invoiceLease: lease, stripeInvoiceId: booking.stripeInvoiceId }), { $set: { status: "canceled", canceledAt: new Date(), invoiceFunded: false, invoiceObservedAt: new Date(), "invoice.status": invoice.status, "invoice.amountPaidMinor": read.observed.amountPaidMinor }, $unset: { cancelingAt: 1 }, $inc: { revision: 1, verificationVersion: 1 } }, { new: true }).lean();
	if (!canceled) throw conflict("A newer billing request changed this sponsorship. Retry cancellation before releasing the date.");
	await releaseSlot(account, canceled);
	return canceled;
}
