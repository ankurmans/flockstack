import { createHash } from "node:crypto";
import { getLinkProblem } from "./link-check-rules.js";
import { shiftDateKey, toDateKey } from "./time-zone.js";
import { isObjectIdString } from "./validation.js";
import { hasUnsupportedCreatorFee } from "./payments/stripe-api.js";

export const SPONSOR_LIMITS = { placements: 10, openDays: 730, placementsPerIssue: 10, headline: 120, body: 2000, callToAction: 60, url: 2000, assetBytes: 5 * 1024 * 1024, assetsPerBooking: 5, invoiceDays: 7 };
const ref = value => typeof value === "string" ? value : value?.id ?? null;
const minor = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const epoch = value => Number.isSafeInteger(value) && value > 0 && Number.isFinite(new Date(value * 1000).getTime()) ? new Date(value * 1000).toISOString() : null;

export function checkSponsorshipDay(day, timeZone, now = Date.now()) {
	if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return "Choose a planned day in YYYY-MM-DD format";
	const parsed = new Date(`${day}T12:00:00Z`);
	if (!Number.isFinite(+parsed) || parsed.toISOString().slice(0, 10) !== day) return "Choose a real planned day";
	if (typeof timeZone !== "string" || timeZone.length > 80) return "Choose a valid IANA time zone";
	try { new Intl.DateTimeFormat("en", { timeZone }).format(); } catch { return "Choose a valid IANA time zone"; }
	const today = toDateKey(new Date(now), timeZone);
	if (day < today || day > shiftDateKey(today, SPONSOR_LIMITS.openDays)) return "Choose a planned day within the next 730 days";
	return null;
}

export function checkSponsorCreative(input) {
	if (!input || typeof input !== "object" || Array.isArray(input)) return { problem: "Add the sponsor's creative" };
	const creative = Object.fromEntries(["headline", "body", "callToAction", "url"].map(key => [key, typeof input[key] === "string" ? input[key].replace(/\r\n?/g, "\n").trim() : ""]));
	for (const [key, max] of [["headline", SPONSOR_LIMITS.headline], ["body", SPONSOR_LIMITS.body], ["callToAction", SPONSOR_LIMITS.callToAction], ["url", SPONSOR_LIMITS.url]]) if (!creative[key] || creative[key].length > max) return { problem: `${key}: use 1 to ${max} characters` };
	if (Object.values(creative).some(value => /\{\{|\}\}/.test(value))) return { problem: "Sponsor creative cannot contain merge tags" };
	if (getLinkProblem(creative.url)) return { problem: "Use a public HTTP or HTTPS sponsor address with no credentials and the default port" };
	creative.url = new URL(creative.url).href;
	creative.assetId = input.assetId ? String(input.assetId) : null;
	if (creative.assetId && !isObjectIdString(creative.assetId)) return { problem: "Choose an uploaded sponsor asset" };
	return { creative, hash: createHash("sha256").update(JSON.stringify(creative)).digest("hex") };
}

// Funding authorizes one approved placement. Invoice status and amounts remain separate observed facts: a paid invoice
// can use customer credit or an out-of-band payment and does not prove net cash or a payout.
export function readSponsorshipInvoice(invoice, booking) {
	const metadata = invoice?.metadata;
	const owned = Boolean(invoice?.id && invoice.id === booking?.stripeInvoiceId && ref(invoice.customer) === booking.stripeCustomerId && metadata?.flockstack === "1" && metadata.kind === "sponsorship" && metadata.accountId === String(booking.accountId) && metadata.newsletterId === String(booking.newsletterId) && metadata.bookingId === String(booking._id) && metadata.slotId === String(booking.slotId));
	if (!owned) return { owned: false, supported: false, funded: false, reason: "Stripe returned an invoice for another booking" };
	const observed = {
		id: invoice.id, status: typeof invoice.status === "string" ? invoice.status : null,
		currency: /^[a-z]{3}$/.test(invoice.currency ?? "") ? invoice.currency : null,
		totalMinor: minor(invoice.total), amountPaidMinor: minor(invoice.amount_paid), amountDueMinor: minor(invoice.amount_due),
		paidAt: epoch(invoice.status_transitions?.paid_at),
	};
	const unsupported = reason => ({ owned: true, supported: false, funded: false, observed, reason });
	if (invoice.currency !== booking.currency || ref(invoice.subscription ?? invoice.parent?.subscription_details?.subscription)) return unsupported("The booking needs its own one-time invoice in the agreed currency");
	if (invoice.collection_method !== "send_invoice" || hasUnsupportedCreatorFee(invoice)) return unsupported("The booking invoice has unsupported collection or fee settings");
	const lines = invoice.lines;
	if (!Array.isArray(lines?.data) || lines.has_more || lines.data.length !== 1) return unsupported("The booking invoice needs exactly its agreed placement line");
	const line = lines.data[0];
	const itemId = ref(line.invoice_item ?? line.parent?.invoice_item_details?.invoice_item);
	if (!booking.stripeInvoiceItemId || itemId !== booking.stripeInvoiceItemId || line.amount !== booking.amountMinor || line.currency !== booking.currency || line.proration === true) return unsupported("The placement invoice line changed or cannot be verified");
	return { owned: true, supported: true, funded: invoice.status === "paid" && invoice.paid !== false, observed, reason: null };
}

export function canPlaceSponsorship({ booking, slot, campaign, creativeHash }) {
	if (!booking || !slot || !campaign) return false;
	if ([booking, slot].some(row => String(row.accountId) !== String(campaign.accountId) || String(row.newsletterId) !== String(campaign.newsletterId))) return false;
	return booking.status === "paid" && !booking.cancelingAt && booking.invoiceFunded === true && booking.approvedCreativeHash === creativeHash && Boolean(creativeHash) && slot.status === "reserved" && String(slot.bookingId) === String(booking._id) && String(booking.slotId) === String(slot._id) && (!booking.campaignId || String(booking.campaignId) === String(campaign._id) || String(booking.campaignId) === String(campaign.resend?.of)) && campaign.kind !== "note" && campaign.publishTo !== "web";
}
