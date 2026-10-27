import "server-only";
import { scoped } from "@/lib/account-scope";
import { PUBLISHED_STATUSES } from "@/lib/archive-issues";
import { areCommentsOn } from "@/lib/comment-rules";
import { connectDb } from "@/lib/db";
import { findOpenNewsletter } from "@/lib/public-newsletters";
import { ARCHIVE_SLUG_PATTERN } from "@/lib/slug";
import { findTier, getContactTierId, getNewsletterTiers } from "@/lib/tier-rules";
import { isPaidContact } from "@/lib/tiers";
import { isObjectIdString } from "@/lib/validation";
import Campaign from "@/models/Campaign";
import Comment from "@/models/Comment";
import Contact from "@/models/Contact";

export const MAX_BADGE_COMMENTS = 1000;

export function isCurrentSupporter(newsletter, contact, now = Date.now()) {
	return contact?.status === "active" && isPaidContact(contact, now) && Boolean(findTier(getNewsletterTiers(newsletter), getContactTierId(contact))?.founding.enabled);
}

export async function saveSupporterBadge({ newsletter, contact, enabled }) {
	if (enabled && !isCurrentSupporter(newsletter, contact)) return { problem: "Supporter badges are available to current founding members." };
	const result = await Contact.updateOne(scoped(newsletter.accountId, { _id: contact._id, newsletterId: newsletter._id, status: "active" }), { $set: { "community.supporterBadge": enabled === true, "community.badgeUpdatedAt": new Date() } });
	return result.matchedCount ? { ok: true } : { problem: "Your session ended. Sign in again." };
}

// Called separately from cached issue HTML. No membership or consent bit is ever embedded in that page's payload.
export async function listSupporterBadges({ slug, post, ids, now = Date.now() }) {
	if (typeof slug !== "string" || slug.length > 40 || typeof post !== "string" || !ARCHIVE_SLUG_PATTERN.test(post) || !Array.isArray(ids) || ids.length > MAX_BADGE_COMMENTS) return [];
	const wanted = [...new Set(ids.filter((id) => typeof id === "string" && isObjectIdString(id)))];
	if (!wanted.length) return [];
	await connectDb();
	const newsletter = await findOpenNewsletter({ slug, archiveEnabled: true });
	if (!newsletter || !getNewsletterTiers(newsletter).some((tier) => tier.founding.enabled)) return [];
	const campaign = await Campaign.findOne(scoped(newsletter.accountId, { newsletterId: newsletter._id, archiveSlug: post, status: { $in: PUBLISHED_STATUSES }, publishTo: { $ne: "email" } })).select({ _id: 1, audience: 1, comments: 1 }).lean();
	if (!campaign || !areCommentsOn(newsletter, campaign)) return [];
	const comments = await Comment.find(scoped(newsletter.accountId, { campaignId: campaign._id, status: "published", _id: { $in: wanted } })).select({ _id: 1, authorId: 1 }).limit(MAX_BADGE_COMMENTS).lean();
	const authors = [...new Set(comments.map((row) => row.authorId && String(row.authorId)).filter(Boolean))];
	if (!authors.length) return [];
	const contacts = await Contact.find(scoped(newsletter.accountId, { newsletterId: newsletter._id, _id: { $in: authors }, status: "active", "community.supporterBadge": true })).select({ _id: 1, status: 1, tier: 1, paidUntil: 1, paidTierId: 1 }).lean();
	const eligible = new Set(contacts.filter((contact) => isCurrentSupporter(newsletter, contact, now)).map((contact) => String(contact._id)));
	return comments.filter((comment) => eligible.has(String(comment.authorId))).map((comment) => String(comment._id));
}
