import "server-only";
import { revalidatePath } from "@/lib/runtime-hooks";
import { cache } from "react";
import { ACCESS_FIELDS, hasActiveSubscription } from "@/lib/account-state";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { showsSentWithLink } from "@/lib/free-plan";
import { PUBLISHED_STATUSES } from "@/lib/archive-issues";
import { connectDb } from "@/lib/db";
import { countIssueTags } from "@/lib/issue-tags";
import { getPaymentsState } from "@/lib/payments/connect";
import { PRODUCT_SLUG_PATTERN } from "@/lib/products";
import { ARCHIVE_SLUG_PATTERN } from "@/lib/slug";
import Account from "@/models/Account";
import Campaign from "@/models/Campaign";
import Contact from "@/models/Contact";
import CustomField from "@/models/CustomField";
import Newsletter from "@/models/Newsletter";
import Product from "@/models/Product";
import SitePage from "@/models/SitePage";

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export { PUBLISHED_STATUSES };
const LISTED_FILTER = {
	archiveSlug: { $type: "string" },
	archiveListed: { $ne: false },
	status: { $in: PUBLISHED_STATUSES },
};
const CARD_FIELDS = "kind authorId subject previewText archiveSlug archivePinned sentAt startedAt thumbnailUrl webViews audience audienceTiers seo tags tagSlugs";
// The home page shows this many recent issues and links to the paged list; that list shows ISSUES_PER_PAGE a page.
export const HOME_ISSUES = 12;
export const ISSUES_PER_PAGE = 12;
// A title search looks through this many of the newest issues, and the list of tags through this many: a bounded read
// whatever the archive's size.
export const SEARCH_WINDOW = 500;
const TAG_WINDOW = 1000;
export const MAX_SEARCH_LENGTH = 100;

// A newsletter's website as its home page sees it: on from its first issue, and before that a calm "first issue coming
// soon" page with its signup form (comingSoon). Off, or an account waiting for its deletion, there is none. sentWith:
// whether it carries the "Sent with FlockStack" link.
export const getArchiveSite = cache(async (slug) => {
	if (!SLUG_PATTERN.test(slug)) return null;
	await connectDb();
	const newsletter = await Newsletter.findOne({ slug, archiveEnabled: true })
		.setOptions({ crossAccount: true })
		.select("accountId name slug language readerTranslations meteredReadsPerMonth archiveEnabled archiveHost imageUrl fromName description socialLinks author authors paidTier paidTiers comments linkPage accentColor brand navigation jsonLd popup audio privateArchive")
		.lean();
	if (!newsletter) return null;
	const [account, hasIssue] = await Promise.all([
		Account.findById(newsletter.accountId).select(ACCESS_FIELDS).lean(),
		hasPublishedIssue(newsletter),
	]);
	return hasActiveSubscription(account) ? { ...newsletter, sentWith: showsSentWithLink(account), comingSoon: !hasIssue } : null;
});

// Archives are public by slug, from the newsletter's first issue on: every page but the home page, the sitemap, the feed
// and the rest of what lists or shows issues answer 404 before it. The home page and its layout use getArchiveSite.
export const getArchiveNewsletter = cache(async (slug) => {
	const site = await getArchiveSite(slug);
	if (!site || site.comingSoon) return null;
	const { comingSoon: _comingSoon, ...newsletter } = site;
	return newsletter;
});

// What lists, feeds or reads issues to anyone (the sitemap, the feed, llms.txt, Markdown, tag and author pages, the issue list) asks
// for: a private website (Newsletter.privateArchive) has none of them, so they answer 404. Issue pages ask getArchiveNewsletter
// and show a private website's visitors a gate instead.
export async function getOpenArchiveNewsletter(slug) {
	const newsletter = await getArchiveNewsletter(slug);
	return newsletter && !newsletter.privateArchive ? newsletter : null;
}

// Until its first issue goes out, a newsletter's website is its "first issue coming soon" page and nothing else: on by
// default, it never shows an empty list. The send revalidates the archive (revalidateArchive), so the website goes live with it.
export async function hasPublishedIssue({ accountId, _id }) {
	await connectDb();
	return Boolean(await Campaign.exists({ accountId, newsletterId: _id, status: { $in: PUBLISHED_STATUSES } }));
}

// A picture several listed issues share is the newsletter's banner, not the issue's own. Those issues
// get a generated card instead, so the archive doesn't repeat one image on every card. Unlisted
// issues don't count.
const getSharedThumbnails = cache(async (newsletter) => {
	await connectDb();
	const rows = await Campaign.aggregate([
		{
			$match: {
				accountId: newsletter.accountId,
				newsletterId: newsletter._id,
				thumbnailUrl: { $type: "string" },
				...LISTED_FILTER,
			},
		},
		{ $group: { _id: "$thumbnailUrl", count: { $sum: 1 } } },
		{ $match: { count: { $gt: 1 } } },
	]);
	return new Set(rows.map(({ _id }) => _id));
});

async function withOwnThumbnails(newsletter, issues) {
	const shared = await getSharedThumbnails(newsletter);
	// A paid issue's first picture is part of what's paid for: its card is the generated one.
	return issues.map((issue) => (issue.audience === "paid" || shared.has(issue.thumbnailUrl) ? { ...issue, thumbnailUrl: undefined } : issue));
}

export const getArchiveIssue = cache(async (newsletter, postSlug) => {
	if (!ARCHIVE_SLUG_PATTERN.test(postSlug)) return null;
	await connectDb();
	const issue = await Campaign.findOne({
		accountId: newsletter.accountId,
		newsletterId: newsletter._id,
		archiveSlug: postSlug,
		status: { $in: PUBLISHED_STATUSES },
		publishTo: { $ne: "email" },
	})
		.select(`${CARD_FIELDS} status publishTo comments format markdown html source importedFrom`)
		.lean();
	return issue && (await withOwnThumbnails(newsletter, [issue]))[0];
});

export async function listArchiveIssues(newsletter, { limit = 0, excludeId, authorId } = {}) {
	await connectDb();
	const issues = await Campaign.find({
		accountId: newsletter.accountId,
		newsletterId: newsletter._id,
		...LISTED_FILTER,
		...(excludeId && { _id: { $ne: excludeId } }),
		...(authorId !== undefined && { authorId: authorId === "default" ? null : authorId }),
	})
		.sort({ sentAt: -1, startedAt: -1 })
		.limit(limit)
		.select(CARD_FIELDS)
		.lean();
	return withOwnThumbnails(newsletter, issues);
}

// The home page: the pinned issues, then the newest ones that aren't pinned, and how many issues there are in all so it
// can link to the rest.
export async function listHomeIssues(newsletter) {
	await connectDb();
	const base = { accountId: newsletter.accountId, newsletterId: newsletter._id, ...LISTED_FILTER };
	const [pinned, recent, total] = await Promise.all([
		Campaign.find({ ...base, archivePinned: true }).sort({ sentAt: -1, startedAt: -1 }).limit(12).select(CARD_FIELDS).lean(),
		Campaign.find({ ...base, archivePinned: { $ne: true } }).sort({ sentAt: -1, startedAt: -1 }).limit(HOME_ISSUES + 1).select(CARD_FIELDS).lean(),
		Campaign.countDocuments(base),
	]);
	const [pinnedCards, recentCards] = await Promise.all([withOwnThumbnails(newsletter, pinned), withOwnThumbnails(newsletter, recent)]);
	return { pinned: pinnedCards, recent: recentCards, total };
}

// One page of the list of issues, newest first: all of them, a tag's, or the ones whose title has the words searched for
// (case does not matter), found in the newest SEARCH_WINDOW. page counts from 1; a page past the end is the last one.
export async function listIssuesPage(newsletter, { page = 1, tagSlug = "", search = "" } = {}) {
	await connectDb();
	const base = { accountId: newsletter.accountId, newsletterId: newsletter._id, ...LISTED_FILTER, ...(tagSlug && { tagSlugs: tagSlug }) };
	const words = search.trim().toLowerCase().slice(0, MAX_SEARCH_LENGTH);
	const query = () => Campaign.find(base).sort({ sentAt: -1, startedAt: -1 }).select(CARD_FIELDS);
	let issues;
	let total;
	let pages;
	if (words) {
		const window = await query().limit(SEARCH_WINDOW).lean();
		const found = window.filter((issue) => issue.subject.toLowerCase().includes(words));
		total = found.length;
		pages = Math.max(1, Math.ceil(total / ISSUES_PER_PAGE));
		page = Math.min(Math.max(1, page), pages);
		issues = found.slice((page - 1) * ISSUES_PER_PAGE, page * ISSUES_PER_PAGE);
	} else {
		total = await Campaign.countDocuments(base);
		pages = Math.max(1, Math.ceil(total / ISSUES_PER_PAGE));
		page = Math.min(Math.max(1, page), pages);
		issues = await query().skip((page - 1) * ISSUES_PER_PAGE).limit(ISSUES_PER_PAGE).lean();
	}
	return { issues: await withOwnThumbnails(newsletter, issues), page, pages, total };
}

// The tags of the listed issues, most used first.
export const listIssueTags = cache(async (newsletter) => {
	await connectDb();
	const issues = await Campaign.find({ accountId: newsletter.accountId, newsletterId: newsletter._id, ...LISTED_FILTER, tagSlugs: { $exists: true } })
		.sort({ sentAt: -1, startedAt: -1 })
		.limit(TAG_WINDOW)
		.select("tags tagSlugs")
		.lean();
	return countIssueTags(issues);
});

// The newsletter's published pages, oldest first: the navigation and the sitemap read them.
export const listPublishedPages = cache(async (newsletter) => {
	await connectDb();
	return SitePage.find({ accountId: newsletter.accountId, newsletterId: newsletter._id, status: "published" })
		.sort({ createdAt: 1, _id: 1 })
		.select("title slug description updatedAt")
		.lean();
});

export const getArchivePage = cache(async (newsletter, pageSlug) => {
	if (!ARCHIVE_SLUG_PATTERN.test(pageSlug)) return null;
	await connectDb();
	return SitePage.findOne({ accountId: newsletter.accountId, newsletterId: newsletter._id, slug: pageSlug, status: "published" })
		.select("title slug description html updatedAt")
		.lean();
});

// The RSS feed's issues, newest first, with their content. Listed issues only, like the archive's index.
export async function listFeedIssues(newsletter, { limit = 50 } = {}) {
	await connectDb();
	const issues = await Campaign.find({ accountId: newsletter.accountId, newsletterId: newsletter._id, ...LISTED_FILTER })
		.sort({ sentAt: -1, startedAt: -1 })
		.limit(limit)
		.select(`${CARD_FIELDS} access format markdown html`)
		.lean();
	return withOwnThumbnails(newsletter, issues);
}

// For the API: every listed issue that went out.
export async function listPublishedIssues(newsletter) {
	await connectDb();
	return Campaign.find({ accountId: newsletter.accountId, newsletterId: newsletter._id, ...LISTED_FILTER })
		.sort({ sentAt: -1, startedAt: -1 })
		.select("subject previewText archiveSlug sentAt startedAt")
		.lean();
}

const PRODUCT_CARD_FIELDS = "title slug description priceCents currency imageUrl updatedAt";

// The newsletter's shop: the products on sale, newest first.
export const listShopProducts = cache(async (newsletter) => {
	await connectDb();
	return Product.find({ accountId: newsletter.accountId, newsletterId: newsletter._id, status: "active" })
		.sort({ createdAt: -1, _id: -1 })
		.select(PRODUCT_CARD_FIELDS)
		.lean();
});

export const getShopProduct = cache(async (newsletter, productSlug) => {
	if (!PRODUCT_SLUG_PATTERN.test(productSlug)) return null;
	await connectDb();
	return Product.findOne({ accountId: newsletter.accountId, newsletterId: newsletter._id, slug: productSlug, status: "active" })
		.select(`${PRODUCT_CARD_FIELDS} file.name file.bytes`)
		.lean();
});

// Whether a seller's payments can take a sale now: a product on a page is only bought when it can.
export const getShopPayments = cache(async (newsletter) => {
	await connectDb();
	const account = await Account.findById(newsletter.accountId).select({ payments: 1 }).lean();
	return getPaymentsState(account);
});

// Cached per render: the layout's popup and the page's own subscribe blocks show the same count.
export const countReaders = cache(async (newsletter) => {
	await connectDb();
	return Contact.countDocuments({ accountId: newsletter.accountId, newsletterId: newsletter._id, status: "active" });
});

// The custom fields the newsletter's signup form asks for, after the email.
export const listSignupFields = cache(async (newsletter) => {
	await connectDb();
	const fields = await CustomField.find({ accountId: newsletter.accountId, newsletterId: newsletter._id, onSignupForm: true })
		.sort({ createdAt: 1, _id: 1 })
		.select({ key: 1, label: 1, type: 1, options: 1, multiple: 1 })
		.lean();
	return fields.map(({ key, label, type, options, multiple }) => ({ key, label, type, options: options ?? [], multiple: Boolean(multiple) }));
});

// Cached pages are tagged by route file, so the pattern refreshes every archive page; each
// regenerates on its next visit.
export function revalidateArchive() {
	revalidatePath("/archive/[slug]", "layout");
}

// Unlisted issues keep their page, so only the archive switch, the slug and the send decide.
export function getIssuePageUrl({ campaign, newsletter }) {
	if (!newsletter?.archiveEnabled || !campaign.archiveSlug || !PUBLISHED_STATUSES.includes(campaign.status)) return null;
	return getArchiveUrls(newsletter).absolutePost(campaign.archiveSlug);
}
