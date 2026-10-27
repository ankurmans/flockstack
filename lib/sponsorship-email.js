import "server-only";
import { getSponsorshipEmailCopy } from "@/lib/sponsorship-email-copy";
import Newsletter from "@/models/Newsletter";
import { scoped } from "@/lib/account-scope";
import { actionError } from "@/lib/actions/errors";
import { isRateLimited } from "@/lib/rate-limit";
import { refreshSponsorshipInvoice } from "@/lib/sponsorship-billing";
import SponsorshipBooking from "@/models/SponsorshipBooking";

export async function sendSponsorshipInvoiceEmail({ account, bookingId }) {
	const booking = await refreshSponsorshipInvoice({ account, bookingId });
	if (!booking.verifiedAt || booking.status === "canceled" || booking.cancelingAt || booking.invoiceProblem || booking.invoice?.status !== "open" || !booking.invoice.hostedUrl) throw actionError("conflict", "Only a verified sponsor's current open invoice can be emailed");
	if (await isRateLimited({ name: "sponsor-invoice-email", key: String(booking._id), limit: 3, window: "1 h" })) throw actionError("rate_limited", "Wait before emailing this invoice again");
	const newsletter = await Newsletter.findOne(scoped(account, { _id: booking.newsletterId })).lean();
	if (!newsletter) throw actionError("not_found", "Newsletter not found");
	const { sendTransactionalEmail } = await import("@/lib/sending");
	const result = await sendTransactionalEmail({ accountId: booking.accountId, newsletterId: booking.newsletterId, to: booking.email, ...getSponsorshipEmailCopy(newsletter, booking, "invoice", booking.invoice.hostedUrl) });
	if (result.sent) await SponsorshipBooking.updateOne(scoped(account, { _id: booking._id, stripeInvoiceId: booking.stripeInvoiceId }), { $set: { invoiceEmailSentAt: new Date() } });
	return { sent: result.sent === true };
}
