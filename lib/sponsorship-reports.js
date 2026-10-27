import "server-only";
import { scoped } from "@/lib/account-scope";
import { afterCursor, encodeCursor } from "@/lib/actions/cursor";
import { findSponsorshipRecord } from "@/lib/sponsorship-inventory";
import { sponsorshipInvoiceOutput } from "@/lib/sponsorship-output";
import Campaign from "@/models/Campaign";
import CampaignLink from "@/models/CampaignLink";
import Message from "@/models/Message";
import SponsorshipBooking from "@/models/SponsorshipBooking";

// No contact identities or issue body leave this report. Counts name their observation: acceptance by a provider,
// its later delivery event, and tracked clicks. None is an impression, a unique person, net cash or a payout.
export async function getSponsorshipReport({ account, bookingId, cursor, limit = 10, includeInvoice = false }) {
	const booking = await findSponsorshipRecord(SponsorshipBooking, account, bookingId);
	const pageSize = Math.min(25, Math.max(1, Number.isInteger(limit) ? limit : 10));
	const rows = booking.campaignId ? await Campaign.find(scoped(account, { newsletterId: booking.newsletterId, $or: [{ _id: booking.campaignId }, { "resend.of": booking.campaignId }], ...(cursor && afterCursor(cursor, "createdAt")) })).sort({ createdAt: -1, _id: -1 }).limit(pageSize + 1).lean() : [];
	const page = rows.slice(0, pageSize);
	const issues = await Promise.all(page.map(async campaign => {
		const filter = scoped(account, { newsletterId: booking.newsletterId, campaignId: campaign._id, kind: "campaign", sponsorshipBookingIds: booking._id });
		const links = await CampaignLink.find(scoped(account, { campaignId: campaign._id, sponsorshipBookingId: booking._id })).select("index clicks uniqueClicks").limit(100).lean();
		const [providerAcceptedEmails, deliveredEmails, uniqueMessageClickers] = await Promise.all([
			Message.countDocuments({ ...filter, sentAt: { $ne: null } }),
			Message.countDocuments({ ...filter, sentAt: { $ne: null }, deliveredAt: { $ne: null } }),
			links.length ? Message.countDocuments({ ...filter, sentAt: { $ne: null }, clickedLinks: { $in: links.map(row => row.index) } }) : null,
		]);
		return { campaignId: String(campaign._id), providerAcceptedEmails, deliveredEmails, clicks: links.length ? links.reduce((sum, row) => sum + row.clicks, 0) : null, uniqueMessageClickers, clickTracking: links.length ? "matched_link" : "unavailable", sentAt: campaign.sentAt ? new Date(campaign.sentAt).toISOString() : null };
	}));
	return { bookingId: String(booking._id), plannedDay: booking.day, timeZone: booking.timeZone, issues, nextCursor: rows.length > pageSize ? encodeCursor(page.at(-1).createdAt, page.at(-1)._id) : null, ...(includeInvoice && { invoice: sponsorshipInvoiceOutput(booking) }) };
}
