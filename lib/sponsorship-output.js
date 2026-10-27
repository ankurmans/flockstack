import * as z from "zod";

const date = z.string().nullable();
const iso = value => value ? new Date(value).toISOString() : null;
export const sponsorshipCreativeSchema = z.object({ headline: z.string().max(120), body: z.string().max(2000), callToAction: z.string().max(60), url: z.string().max(2000), assetId: z.string().nullable().optional() });
export const sponsorshipPlacementSchema = z.object({ id: z.string(), newsletterId: z.string(), name: z.string(), description: z.string(), amountMinor: z.number().int(), currency: z.string(), archived: z.boolean() });
export const sponsorshipSlotSchema = z.object({ id: z.string(), newsletterId: z.string(), placementId: z.string(), placementName: z.string(), day: z.string(), timeZone: z.string(), amountMinor: z.number().int(), currency: z.string(), status: z.enum(["open", "reserved", "closed"]), bookingId: z.string().nullable() });
export const sponsorshipBookingSchema = z.object({ id: z.string(), newsletterId: z.string(), slotId: z.string(), placementName: z.string(), day: z.string(), timeZone: z.string(), amountMinor: z.number().int(), currency: z.string(), email: z.string(), brandName: z.string(), status: z.enum(["unverified", "requested", "accepted", "invoiced", "paid", "canceled"]), verifiedAt: date, creative: sponsorshipCreativeSchema.nullable(), creativeHash: z.string().nullable(), approvedCreativeHash: z.string().nullable(), approvedAt: date, invoiceFunded: z.boolean(), invoiceObservedAt: date, invoiceProblem: z.string().nullable(), invoiceStatus: z.string().nullable(), cancellationPending: z.boolean(), campaignId: z.string().nullable(), createdAt: date });
export const sponsorshipInvoiceSchema = z.object({ id: z.string().nullable(), status: z.string().nullable(), currency: z.string().nullable(), totalMinor: z.number().nullable(), amountPaidMinor: z.number().nullable(), amountDueMinor: z.number().nullable(), paidAt: date, hostedUrl: z.string().nullable(), pdfUrl: z.string().nullable(), observedAt: date, problem: z.string().nullable() });
export const sponsorshipAssetSchema = z.object({ id: z.string(), bookingId: z.string(), fileName: z.string(), contentType: z.string(), bytes: z.number().int(), status: z.enum(["uploading", "ready", "deleted"]), publicAt: date, publicUrl: z.string().nullable() });

export function sponsorshipPlacementOutput(row) {
	return { id: String(row._id), newsletterId: String(row.newsletterId), name: row.name, description: row.description ?? "", amountMinor: row.amountMinor, currency: row.currency, archived: row.archived === true };
}
export function sponsorshipSlotOutput(row) {
	return { id: String(row._id), newsletterId: String(row.newsletterId), placementId: String(row.placementId), placementName: row.placementName, day: row.day, timeZone: row.timeZone, amountMinor: row.amountMinor, currency: row.currency, status: row.status, bookingId: row.bookingId ? String(row.bookingId) : null };
}
export function sponsorshipBookingOutput(row) {
	return { id: String(row._id), newsletterId: String(row.newsletterId), slotId: String(row.slotId), placementName: row.placementName, day: row.day, timeZone: row.timeZone, amountMinor: row.amountMinor, currency: row.currency, email: row.email, brandName: row.brandName, status: row.status, verifiedAt: iso(row.verifiedAt), creative: row.creative?.headline ? { headline: row.creative.headline, body: row.creative.body ?? "", callToAction: row.creative.callToAction ?? "", url: row.creative.url ?? "", assetId: row.creative.assetId ? String(row.creative.assetId) : null } : null, creativeHash: row.creativeHash ?? null, approvedCreativeHash: row.approvedCreativeHash ?? null, approvedAt: iso(row.approvedAt), invoiceFunded: row.invoiceFunded === true, invoiceObservedAt: iso(row.invoiceObservedAt), invoiceProblem: row.invoiceProblem ?? null, invoiceStatus: row.invoice?.status ?? null, cancellationPending: Boolean(row.cancelingAt), campaignId: row.campaignId ? String(row.campaignId) : null, createdAt: iso(row.createdAt) };
}
export function sponsorshipInvoiceOutput(row) {
	const invoice = row.invoice ?? {};
	return { id: invoice.id ?? null, status: invoice.status ?? null, currency: invoice.currency ?? null, totalMinor: invoice.totalMinor ?? null, amountPaidMinor: invoice.amountPaidMinor ?? null, amountDueMinor: invoice.amountDueMinor ?? null, paidAt: iso(invoice.paidAt), hostedUrl: invoice.hostedUrl ?? null, pdfUrl: invoice.pdfUrl ?? null, observedAt: iso(row.invoiceObservedAt), problem: row.invoiceProblem ?? null };
}
