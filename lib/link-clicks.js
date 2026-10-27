import "server-only";
import { getLinkBaseUrl } from "@/lib/archive-hosts";
import { enrollOnLinkClicked } from "@/lib/automation-triggers";
import { hasRecommendationsTag } from "@/lib/recommendation-tags";
import { getEmailRecommendations } from "@/lib/recommendations";
import { TEST_CONTACT_ID, buildRecipientEmail } from "@/lib/sending-rules";
import { escapeHtml } from "@/lib/escape-html";
import { sponsorshipLinkIndexes } from "@/lib/sponsorship-blocks";
import { getOpenUrl, readClickToken, readTrackedLinks, replaceTrackedLinks } from "@/lib/tracking";
import CampaignLink from "@/models/CampaignLink";
import Contact from "@/models/Contact";
import Message from "@/models/Message";

// Stored URLs stay short enough that a report of every link stays small.
const MAX_URL_LENGTH = 2000;
const BADGE_STYLE =
	"display:inline-block;margin:0 4px 0 0;padding:0 6px;border-radius:9999px;background:#d9f99d;color:#1a2e05;font:600 11px/18px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;text-decoration:none;vertical-align:middle;";

// The email every recipient of the campaign gets, as a reader with no data of their own would: the same links in the
// same places as in each recipient's own copy. Personal links (a referral link, a comment sign-in) are the same link
// in every copy, with another reader's details.
async function renderTrackedEmail(campaign, newsletter) {
	const hasBlock = hasRecommendationsTag(campaign.html) || hasRecommendationsTag(campaign.markdown);
	return buildRecipientEmail({
		campaign,
		newsletter,
		contact: { _id: TEST_CONTACT_ID, email: newsletter.fromEmail },
		recommendations: hasBlock ? await getEmailRecommendations(newsletter) : null,
		messageId: TEST_CONTACT_ID,
	});
}

// Run as a send starts: one row per tracked link, which its clicks count on. A retried start keeps the rows it has.
export async function saveCampaignLinks(campaign, newsletter) {
	const { html } = await renderTrackedEmail(campaign, newsletter);
	const links = readTrackedLinks(html);
	const sponsors = new Map();
	const approvedLinks = sponsorshipLinkIndexes(campaign.html);
	for (const match of html.matchAll(/<a\b[^>]*>/gi)) {
		const bookingId = /\sdata-sponsor-booking="([a-f0-9]{24})"/i.exec(match[0])?.[1];
		const href = /\shref="([^"]+)"/i.exec(match[0])?.[1];
		const tracked = href && readClickToken(/\/c\/([^/?#]+)$/.exec(href)?.[1]);
		if (bookingId && tracked?.isSigned && Number.isInteger(tracked.link) && approvedLinks.get(bookingId) === tracked.link) sponsors.set(tracked.link, bookingId);
	}
	if (links.length === 0) return 0;
	try {
		await CampaignLink.insertMany(
			links.map(({ index, url }) => ({ accountId: campaign.accountId, campaignId: campaign._id, index, url: url.slice(0, MAX_URL_LENGTH), ...(sponsors.has(index) && { sponsorshipBookingId: sponsors.get(index) }) })),
			{ ordered: false }
		);
	} catch (error) {
		const codes = (error?.writeErrors ?? []).map(({ err, code }) => err?.code ?? code);
		if (!(codes.length > 0 ? codes.every((code) => code === 11000) : error?.code === 11000)) throw error;
	}
	return links.length;
}

// A click on a campaign email's link: its total goes up each time; its unique count only the first time this
// email's reader clicks it, which the email itself remembers.
export async function countLinkClick(message, link) {
	if (message.kind !== "campaign" || !message.campaignId || !Number.isInteger(link)) return;
	const { accountId } = message;
	const { modifiedCount } = await Message.updateOne(
		{ accountId, _id: message._id, clickedLinks: { $ne: link } },
		{ $addToSet: { clickedLinks: link } }
	);
	const row = await CampaignLink.findOneAndUpdate(
		{ accountId, campaignId: message.campaignId, index: link },
		{ $inc: { clicks: 1, ...(modifiedCount && { uniqueClicks: 1 }) } },
		{ returnDocument: "after" }
	).lean();
	if (modifiedCount && row && message.contactId) await startLinkAutomations(message, row);
}

// A reader's first click on a link starts the automations that wait for it. Never breaks counting the click.
async function startLinkAutomations(message, link) {
	try {
		const contact = await Contact.findOne({ accountId: message.accountId, _id: message.contactId }).lean();
		if (contact) await enrollOnLinkClicked(contact, { campaignId: message.campaignId, url: link.url });
	} catch (error) {
		console.error(`[link-clicks] Could not start the automations for message ${message._id}:`, error.message);
	}
}

export async function listCampaignLinks(campaign) {
	return CampaignLink.find({ accountId: campaign.accountId, campaignId: campaign._id }).sort({ index: 1 }).lean();
}

// The email as it went out, with each tracked link's unique clicks on a badge before it, for the report's click map.
// Links lead to their real address, the unsubscribe link nowhere, and the open pixel is left out.
export async function getClickMapHtml(campaign, newsletter, links) {
	const email = await renderTrackedEmail(campaign, newsletter);
	const counts = new Map(links.map((link) => [link.index, link.uniqueClicks ?? 0]));
	const pixel = `<img src="${getOpenUrl(getLinkBaseUrl(newsletter), TEST_CONTACT_ID)}"`;
	const withoutPixel = email.html.replace(new RegExp(`${pixel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^>]*>`), "");
	return replaceTrackedLinks(withoutPixel.replaceAll(email.unsubscribeUrl, "#"), ({ link, url, start, quote }) => {
		const count = counts.get(link) ?? 0;
		const label = `${count} unique ${count === 1 ? "click" : "clicks"}`;
		return `<span style="${BADGE_STYLE}" title="${label}" aria-label="${label}" data-link="${link}">${count}</span>${start}${quote}${escapeHtml(url)}${quote}`;
	});
}
