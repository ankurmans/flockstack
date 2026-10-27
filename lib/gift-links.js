import "server-only";
import { cookies, headers } from "next/headers";
import { scoped } from "@/lib/account-scope";
import { actionError } from "@/lib/actions/errors";
import { PUBLISHED_STATUSES } from "@/lib/archive-issues";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { getArchiveIssue, getArchiveNewsletter } from "@/lib/archive-data";
import { createContactToken, verifyContactToken } from "@/lib/contact-token";
import { connectDb } from "@/lib/db";
import { GIFT_CODE_PATTERN, GIFT_OPEN_COOKIE_DAYS, GIFT_REFUSALS, getGiftLinkExpiry, getGiftLinkSettings, getGiftLinkState, getMonthStart, newGiftCode } from "@/lib/gift-link-rules";
import { findOpenNewsletter } from "@/lib/public-newsletters";
import { getClientIp, isRateLimited } from "@/lib/rate-limit";
import { listLiveRecommendations } from "@/lib/recommendations";
import { findSessionReader } from "@/lib/reader-session";
import { ARCHIVE_SLUG_PATTERN } from "@/lib/slug";
import { isInPaidTiers, isPaidContact } from "@/lib/tiers";
import { isObjectIdString } from "@/lib/validation";
import { renderWebIssue } from "@/lib/web-issue";
import Campaign from "@/models/Campaign";
import GiftLink from "@/models/GiftLink";

const OPEN_INFO = "flockstack-gift-open-v1";
const OPEN_PER_VISITOR = { name: "gift-link-open", limit: 60, window: "10 m" };
const MAKE_PER_READER = { name: "gift-link-make", limit: 20, window: "1 h" };

// The address a gift link has: the issue's page with the secret code, on the newsletter's own host.
export function getGiftLinkUrl(newsletter, issue, code) {
	return `${getArchiveUrls(newsletter).absolutePost(issue.archiveSlug)}?gift=${encodeURIComponent(code)}`;
}

// An issue a link can open: a paid one with a web page of its own, sent and listed on a website that is on.
export async function findGiftableIssue(account, newsletter, campaignId) {
	const issue = isObjectIdString(String(campaignId ?? "")) ? await Campaign.findOne(scoped(account, { _id: campaignId, newsletterId: newsletter._id })).lean() : null;
	if (!issue) throw actionError("not_found", "Issue not found");
	if (!PUBLISHED_STATUSES.includes(issue.status) || issue.publishTo === "email" || !issue.archiveSlug) throw actionError("conflict", "A gift link needs an issue that has been sent and has a page on your website");
	if (issue.audience !== "paid") throw actionError("conflict", "This issue is free: everyone can already read it");
	if (!newsletter.archiveEnabled) throw actionError("conflict", "Turn on your website first: a gift link opens the issue's page");
	return issue;
}

export async function createGiftLink({ account, newsletter, issue, createdBy, contact = null, opens, days, note = "" }) {
	const settings = getGiftLinkSettings(newsletter);
	const maxOpens = opens ?? settings.opensPerLink;
	const link = await GiftLink.create({
		accountId: account._id ?? account,
		newsletterId: newsletter._id,
		campaignId: issue._id,
		code: newGiftCode(),
		createdBy,
		...(contact && { contactId: contact._id }),
		...(note && { note }),
		maxOpens,
		expiresAt: getGiftLinkExpiry(days ?? settings.days),
	});
	return link.toObject();
}

export async function revokeGiftLink(account, id) {
	const link = isObjectIdString(String(id)) ? await GiftLink.findOne(scoped(account, { _id: id })).lean() : null;
	if (!link) throw actionError("not_found", "Gift link not found");
	if (link.revokedAt) return link;
	const revokedAt = new Date();
	await GiftLink.updateOne(scoped(account, { _id: link._id, revokedAt: { $exists: false } }), { $set: { revokedAt } });
	return { ...link, revokedAt };
}

// A paid reader's own link for the issue they are reading, within the owner's allowance. { url, opens, days, left } or { error }.
export async function createReaderGiftLink({ slug, post }) {
	if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(String(slug ?? "")) || !ARCHIVE_SLUG_PATTERN.test(String(post ?? ""))) return { error: "This issue can't be shared." };
	await connectDb();
	const newsletter = await findOpenNewsletter({ slug, archiveEnabled: true });
	const settings = newsletter && getGiftLinkSettings(newsletter);
	if (!settings?.enabled) return { error: "Sharing is off for this newsletter." };
	const reader = await findSessionReader(newsletter);
	if (!reader) return { error: "Your session ended. Sign in again." };
	const issue = await Campaign.findOne(scoped(newsletter.accountId, { newsletterId: newsletter._id, archiveSlug: post, status: { $in: PUBLISHED_STATUSES }, publishTo: { $ne: "email" } })).lean();
	if (!issue || issue.audience !== "paid") return { error: "Only paid issues have gift links." };
	if (!isPaidContact(reader) || !isInPaidTiers(reader, issue.audienceTiers)) return { error: "Gift links are for paid subscribers who can read this issue." };
	if (await isRateLimited({ ...MAKE_PER_READER, key: `${newsletter._id}:${reader._id}` })) return { error: "Too many links just now. Try again in a while." };
	const monthStart = getMonthStart();
	const made = await GiftLink.countDocuments(scoped(newsletter.accountId, { newsletterId: newsletter._id, contactId: reader._id, createdBy: "reader", createdAt: { $gte: monthStart } }));
	if (made >= settings.perReaderPerMonth) return { error: `You can share ${settings.perReaderPerMonth} ${settings.perReaderPerMonth === 1 ? "issue" : "issues"} a month, and you have used them.` };
	const link = await createGiftLink({ account: newsletter.accountId, newsletter, issue, createdBy: "reader", contact: reader });
	return { url: getGiftLinkUrl(newsletter, issue, link.code), opens: link.maxOpens, days: settings.days, left: settings.perReaderPerMonth - made - 1 };
}

// The page everyone gets shows a paid issue as a teaser; a browser that arrived with ?gift= asks here for the whole of this one issue.
// A browser counts once for a link (it keeps a signed note of it), so reading again or reloading doesn't use the link up.
export async function openGiftIssue({ slug, post, code }) {
	if (!GIFT_CODE_PATTERN.test(String(code ?? "")) || !ARCHIVE_SLUG_PATTERN.test(String(post ?? ""))) return { unlocked: false, reason: "unknown", message: GIFT_REFUSALS.unknown };
	if (await isRateLimited({ ...OPEN_PER_VISITOR, key: getClientIp(await headers()) })) return { unlocked: false, reason: "busy", message: "Too many tries from your network. Try again in a few minutes." };
	await connectDb();
	const newsletter = await getArchiveNewsletter(String(slug ?? ""));
	const link = newsletter && (await GiftLink.findOne({ code }).setOptions({ crossAccount: true }).lean());
	const issue = link && String(link.newsletterId) === String(newsletter._id) ? await getArchiveIssue(newsletter, String(post)) : null;
	if (!issue || String(issue._id) !== String(link.campaignId) || issue.audience !== "paid") return { unlocked: false, reason: "unknown", message: GIFT_REFUSALS.unknown };

	const now = new Date();
	const state = getGiftLinkState(link, now);
	const jar = await cookies();
	const cookieName = `fs_gift_${newsletter.slug}_${String(link._id).slice(-10)}`;
	const noted = verifyContactToken(jar.get(cookieName)?.value, { info: OPEN_INFO, maxAgeMs: GIFT_OPEN_COOKIE_DAYS * 86_400_000, now: now.getTime() });
	const isKnownBrowser = noted?.contactId === String(link._id);
	if (state === "revoked" || state === "expired" || (state === "used_up" && !isKnownBrowser)) return { unlocked: false, reason: state, message: GIFT_REFUSALS[state] };

	if (!isKnownBrowser) {
		const counted = await GiftLink.updateOne(
			scoped(link.accountId, { _id: link._id, opens: { $lt: link.maxOpens }, revokedAt: { $exists: false }, expiresAt: { $gt: now } }),
			{ $inc: { opens: 1 }, $set: { lastOpenedAt: now } }
		);
		if (!counted.matchedCount) return { unlocked: false, reason: "used_up", message: GIFT_REFUSALS.used_up };
		jar.set(cookieName, createContactToken({ info: OPEN_INFO, contactId: link._id, newsletterId: newsletter._id }), {
			httpOnly: true,
			sameSite: "lax",
			secure: process.env.NODE_ENV === "production",
			path: "/",
			maxAge: GIFT_OPEN_COOKIE_DAYS * 86_400,
		});
	}
	const recommendations = await listLiveRecommendations(newsletter).catch(() => []);
	const body = renderWebIssue({ newsletter, issue, recommendations, isUnlocked: true, readerTier: "paid" });
	return { unlocked: true, gift: true, kind: body.kind, html: body.html, audioAllowed: false, ...(body.isPartial && { isPartial: true }) };
}
