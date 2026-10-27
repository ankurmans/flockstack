import "server-only";
import { scoped } from "@/lib/account-scope";
import { actionError } from "@/lib/actions/errors";
import { getPublicSponsorshipAssetUrl } from "@/lib/sponsorship-assets";
import { currentSponsorshipAccount } from "@/lib/sponsorship-bookings";
import { findSponsorshipRecord } from "@/lib/sponsorship-inventory";
import { findSponsorshipBlocks, sponsorshipBlockHtml } from "@/lib/sponsorship-blocks";
import { canPlaceSponsorship, checkSponsorCreative, SPONSOR_LIMITS } from "@/lib/sponsorship-rules";
import { getReaderLanguage } from "@/lib/reader-languages";
import Campaign from "@/models/Campaign";
import Newsletter from "@/models/Newsletter";
import SponsorshipAsset from "@/models/SponsorshipAsset";
import SponsorshipBooking from "@/models/SponsorshipBooking";
import SponsorshipSlot from "@/models/SponsorshipSlot";

const conflict = message => actionError("send_check_failed", message);

async function approvedSnapshot(account, booking, campaign) {
	const checked = checkSponsorCreative(booking.creative);
	const slot = await findSponsorshipRecord(SponsorshipSlot, account, booking.slotId);
	if (checked.problem || checked.hash !== booking.creativeHash || !canPlaceSponsorship({ booking, slot, campaign, creativeHash: checked.hash })) throw conflict("A sponsor placement is no longer paid, reserved and approved for this issue. Review it before sending.");
	let imageUrl = null;
	if (checked.creative.assetId) {
		const asset = await SponsorshipAsset.findOne(scoped(account, { _id: checked.creative.assetId, newsletterId: campaign.newsletterId, bookingId: booking._id, status: "ready", publicAt: { $ne: null } })).lean();
		if (!asset?.publicationConsentAt) throw conflict("The sponsor image is no longer approved for public use");
		imageUrl = getPublicSponsorshipAssetUrl(asset);
	}
	return { id: String(booking._id), hash: checked.hash, creative: checked.creative, imageUrl };
}

export async function prepareSponsorshipBlock({ account, bookingId, campaignId }) {
	account = await currentSponsorshipAccount(account, { change: true });
	const campaign = await findSponsorshipRecord(Campaign, account, campaignId);
	if (campaign.status !== "draft" || campaign.format !== "rich") throw conflict("Choose a draft issue in the rich editor before inserting a sponsor");
	let booking = await findSponsorshipRecord(SponsorshipBooking, account, bookingId);
	const snapshot = await approvedSnapshot(account, booking, campaign);
	const bound = await SponsorshipBooking.findOneAndUpdate(scoped(account, { _id: booking._id, status: "paid", cancelingAt: null, invoiceFunded: true, approvedCreativeHash: snapshot.hash, revision: booking.revision, $or: [{ campaignId: null }, { campaignId: campaign._id }] }), { $set: { campaignId: campaign._id }, $inc: { revision: 1 } }, { new: true }).lean();
	if (!bound) throw conflict("This sponsor placement changed before insertion. Refresh and review it again.");
	booking = bound;
	const newsletter = await Newsletter.findOne(scoped(account, { _id: campaign.newsletterId })).select("language").lean();
	return { bookingId: String(booking._id), campaignId: String(campaign._id), html: sponsorshipBlockHtml({ ...snapshot, language: getReaderLanguage(newsletter) }) };
}

export async function detachSponsorshipBooking({ account, bookingId }) {
	const booking = await findSponsorshipRecord(SponsorshipBooking, account, bookingId);
	if (!booking.campaignId) return { detached: true };
	const campaign = await findSponsorshipRecord(Campaign, account, booking.campaignId);
	if (campaign.status !== "draft") throw conflict("Only a draft placement can be detached. Sent placements remain part of their delivery record.");
	if (findSponsorshipBlocks(campaign.html).some(block => block.data?.id === String(booking._id))) throw conflict("Remove the sponsor block from the draft and wait for it to save before detaching");
	const removed = await SponsorshipBooking.updateOne(scoped(account, { _id: booking._id, campaignId: campaign._id, revision: booking.revision }), { $unset: { campaignId: 1 }, $inc: { revision: 1 } });
	if (!removed.matchedCount) throw conflict("This placement changed before it was detached");
	return { detached: true };
}

export async function assertCampaignSponsorships(campaign) {
	const html = String(campaign.html ?? "");
	if (/\bdata-sponsor-booking\s*=/i.test(html)) throw conflict("Insert sponsors with a verified sponsor block; reserved reporting attributes cannot be written by hand");
	const marked = (html.match(/\bdata-sponsorship\s*=/gi) ?? []).length;
	if (!marked) return;
	const blocks = findSponsorshipBlocks(html);
	if (campaign.format !== "rich" || blocks.length !== marked || blocks.some(block => !block.data) || blocks.length > SPONSOR_LIMITS.placementsPerIssue || new Set(blocks.map(block => block.data?.id)).size !== blocks.length) throw conflict("Use at most 10 valid sponsor blocks, with each booking placed once, in a rich issue");
	for (const { data } of blocks) {
		const booking = await findSponsorshipRecord(SponsorshipBooking, campaign.accountId, data.id);
		if (String(booking.campaignId) !== String(campaign._id) && String(booking.campaignId) !== String(campaign.resend?.of)) throw conflict("This sponsor booking is attached to another issue");
		const current = await approvedSnapshot(campaign.accountId, booking, campaign);
		const checked = checkSponsorCreative(data.creative);
		if (checked.problem || checked.hash !== current.hash || data.hash !== current.hash || data.imageUrl !== current.imageUrl) throw conflict("The sponsor block differs from the approved creative. Reinsert its current version before sending.");
	}
}
