import "server-only";
import * as z from "zod";
import { scoped } from "@/lib/account-scope";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { afterCursor, dateOutput, encodeCursor, findNewsletter, idInput, newsletterInput, toId, toIso } from "@/lib/actions/shared";
import { getIssuePageUrl } from "@/lib/archive-data";
import { toSnippet } from "@/lib/comment-body";
import { MODERATION_ACTIONS, blockCommenter, findComment, moderateComment, refreshArchivePages, unblockCommenter } from "@/lib/comment-moderation";
import { COMMENT_ISSUE_MODES, COMMENT_MODERATION, COMMENT_STATUSES, COMMENT_WHO, MAX_REASON_CHARS, areCommentsOn, getCommentSettings } from "@/lib/comment-rules";
import { isObjectIdString } from "@/lib/validation";
import Campaign from "@/models/Campaign";
import Comment from "@/models/Comment";
import CommentReport, { REPORT_STATUSES } from "@/models/CommentReport";
import Contact from "@/models/Contact";
import Newsletter from "@/models/Newsletter";

const GROUP = "Comments";
const LIST_PAGE = 50;
const commentId = idInput("comment");
const reasonInput = z.string().trim().max(MAX_REASON_CHARS).describe(`Why, in your words, ${MAX_REASON_CHARS} characters at most. The comment's author reads it.`);

const SettingsSchema = z.object({
	newsletterId: z.string(),
	enabled: z.boolean().describe("Whether the newsletter's issues have comments on their web pages. An issue can differ: see the issue field."),
	who: z.enum(COMMENT_WHO).describe("everyone: any active subscriber. paid: paid subscribers only."),
	moderation: z.enum(COMMENT_MODERATION).describe("none: comments show at once. hold_links: a comment with a link waits for you. hold_all: every comment waits for you."),
	notifyOwner: z.boolean().describe("Whether you get one email an hour at most about new comments and reports"),
	hasWebsite: z.boolean().describe("Comments live on the newsletter's website. Without it, nothing shows."),
});

const IssueSchema = z.object({
	id: z.string(),
	subject: z.string(),
	comments: z.enum(COMMENT_ISSUE_MODES).nullable().describe("This issue's own word: on, off, or null to follow the newsletter"),
	isOn: z.boolean().describe("Whether its page has comments now. An issue for paid subscribers only has a teaser page, with none."),
});

const CountsSchema = z.object({
	published: z.number().int(),
	held: z.number().int().describe("Waiting for you"),
	hidden: z.number().int(),
	removed: z.number().int(),
	reported: z.number().int().describe("Comments with open reports"),
});

const AuthorSchema = z.object({
	contactId: z.string().nullable().describe("null once the reader's contact was deleted"),
	email: z.string().nullable().describe("Only you see it. Other readers never do."),
	isBlocked: z.boolean().describe("Commenting is turned off for them (block_commenter)"),
	blockedReason: z.string().nullable(),
});

const CommentSchema = z.object({
	id: z.string(),
	issueId: z.string(),
	issueSubject: z.string(),
	url: z.string().nullable().describe("The issue's page, at this comment"),
	parentId: z.string().nullable().describe("The comment it replies to. Replies go one level deep."),
	status: z.enum(COMMENT_STATUSES),
	reason: z.string().nullable().describe("Why it is held, hidden or removed. The author sees the same words."),
	decidedBy: z.enum(["rules", "creator", "author"]).nullable().describe("rules: your moderation setting held it. creator: you hid, removed or approved it. author: its author deleted it."),
	body: z.string().describe("Plain text; empty once its author deleted it"),
	authorName: z.string().describe("The name readers see"),
	author: AuthorSchema,
	openReports: z.number().int(),
	edited: z.boolean(),
	createdAt: dateOutput,
	updatedAt: dateOutput,
});

const ReportSchema = z.object({
	id: z.string(),
	commentId: z.string(),
	status: z.enum(REPORT_STATUSES).describe("open: you haven't decided. actioned: you hid or removed the comment. dismissed: you approved it."),
	reason: z.string().nullable().describe("What the reporter said, if anything"),
	reporter: z.object({ contactId: z.string().nullable(), name: z.string().nullable(), email: z.string().nullable() }),
	comment: z.object({ status: z.enum(COMMENT_STATUSES), authorName: z.string(), snippet: z.string() }).nullable().describe("null once the comment was deleted"),
	createdAt: dateOutput,
	resolvedAt: dateOutput,
});

function toSettings(newsletter) {
	return { newsletterId: String(newsletter._id), ...getCommentSettings(newsletter), hasWebsite: Boolean(newsletter.archiveEnabled) };
}

// The contacts and issues a page of comments names, in two reads.
async function hydrate(account, newsletter, comments) {
	const [contacts, campaigns] = await Promise.all([
		Contact.find(scoped(account, { _id: { $in: comments.map(({ authorId }) => authorId).filter(Boolean) } }))
			.select({ email: 1, community: 1 })
			.lean(),
		Campaign.find(scoped(account, { _id: { $in: [...new Set(comments.map(({ campaignId }) => String(campaignId)))] } }))
			.select({ subject: 1, archiveSlug: 1, status: 1 })
			.lean(),
	]);
	const contactsById = new Map(contacts.map((contact) => [String(contact._id), contact]));
	const campaignsById = new Map(campaigns.map((campaign) => [String(campaign._id), campaign]));
	return comments.map((comment) => {
		const contact = contactsById.get(String(comment.authorId));
		const campaign = campaignsById.get(String(comment.campaignId));
		const page = campaign && getIssuePageUrl({ campaign, newsletter });
		return {
			id: String(comment._id),
			issueId: String(comment.campaignId),
			issueSubject: campaign?.subject ?? "",
			url: page ? `${page}#comment-${comment._id}` : null,
			parentId: toId(comment.parentId),
			status: comment.status,
			reason: comment.reason ?? null,
			decidedBy: comment.decidedBy ?? null,
			body: comment.body ?? "",
			authorName: comment.authorName,
			author: {
				contactId: contact ? String(contact._id) : null,
				email: contact?.email ?? null,
				isBlocked: Boolean(contact?.community?.blocked),
				blockedReason: contact?.community?.blockedReason ?? null,
			},
			openReports: comment.reports ?? 0,
			edited: Boolean(comment.edited),
			createdAt: toIso(comment.createdAt),
			updatedAt: toIso(comment.updatedAt),
		};
	});
}

async function loadNewsletter(account, id) {
	return Newsletter.findOne(scoped(account, { _id: id })).lean();
}

async function toOutput(account, comment) {
	const newsletter = await loadNewsletter(account, comment.newsletterId);
	return (await hydrate(account, newsletter, [comment]))[0];
}

async function getCounts(account, newsletterId) {
	const count = (filter) => Comment.countDocuments(scoped(account, { newsletterId, ...filter }));
	const [published, held, hidden, removed, reported] = await Promise.all([
		count({ status: "published" }),
		count({ status: "held" }),
		count({ status: "hidden" }),
		count({ status: "removed" }),
		count({ reports: { $gt: 0 } }),
	]);
	return { published, held, hidden, removed, reported };
}

const listComments = defineAction({
	name: "list_comments",
	title: "List comments",
	group: GROUP,
	description: `Lists a newsletter's comments across its issues, newest first, ${LIST_PAGE} a page, with what each needs from you: held comments wait for your review (reason included), reported ones have open reports. A comment's author sees the same reason you do. Readers comment on the newsletter's web issues once they sign in with a link emailed to them: they have no account and no password, and other readers never see their email. Also returns the newsletter's comment settings and how many comments are in each state. Pass nextCursor back as cursor for the next page.`,
	http: { method: "GET", path: "/comments" },
	readOnly: true,
	example: { status: "held" },
	input: z.object({
		newsletter: newsletterInput,
		status: z.enum(COMMENT_STATUSES).optional().describe("Only comments in this state"),
		reported: z.boolean().optional().describe("true: only comments with open reports"),
		issue: z.string().trim().min(1).max(100).optional().describe("Only this issue's comments: the campaign's ID"),
		limit: z.number().int().min(1).max(100).optional().describe(`Comments per page, ${LIST_PAGE} by default, 100 at most`),
		cursor: z.string().max(200).optional().describe("nextCursor from the previous page"),
	}),
	output: z.object({
		comments: z.array(CommentSchema),
		nextCursor: z.string().nullable().describe("null on the last page"),
		counts: CountsSchema,
		settings: SettingsSchema,
	}),
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.newsletter);
		if (input.issue && !isObjectIdString(input.issue)) throw actionError("validation_failed", "issue: use a campaign's ID");
		const limit = input.limit ?? LIST_PAGE;
		const filter = scoped(account, {
			newsletterId: newsletter._id,
			...(input.status && { status: input.status }),
			...(input.reported && { reports: { $gt: 0 } }),
			...(input.issue && { campaignId: input.issue }),
			...(input.cursor && afterCursor(input.cursor, "createdAt")),
		});
		const found = await Comment.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean();
		const page = found.slice(0, limit);
		const last = page.at(-1);
		return {
			comments: await hydrate(account, newsletter, page),
			nextCursor: found.length > limit ? encodeCursor(last.createdAt, last._id) : null,
			counts: await getCounts(account, newsletter._id),
			settings: toSettings(newsletter),
		};
	},
});

async function hydrateReports(account, reports) {
	const [contacts, comments] = await Promise.all([
		Contact.find(scoped(account, { _id: { $in: reports.map(({ reporterId }) => reporterId) } }))
			.select({ email: 1, community: 1 })
			.lean(),
		Comment.find(scoped(account, { _id: { $in: reports.map(({ commentId }) => commentId) } }))
			.select({ status: 1, authorName: 1, body: 1 })
			.lean(),
	]);
	const contactsById = new Map(contacts.map((contact) => [String(contact._id), contact]));
	const commentsById = new Map(comments.map((comment) => [String(comment._id), comment]));
	return reports.map((report) => {
		const reporter = contactsById.get(String(report.reporterId));
		const comment = commentsById.get(String(report.commentId));
		return {
			id: String(report._id),
			commentId: String(report.commentId),
			status: report.status,
			reason: report.reason ?? null,
			reporter: { contactId: reporter ? String(reporter._id) : null, name: reporter?.community?.displayName ?? null, email: reporter?.email ?? null },
			comment: comment ? { status: comment.status, authorName: comment.authorName, snippet: toSnippet(comment.body, 160) } : null,
			createdAt: toIso(report.createdAt),
			resolvedAt: toIso(report.resolvedAt),
		};
	});
}

const getComment = defineAction({
	name: "get_comment",
	title: "Get a comment",
	group: GROUP,
	description: "Gets one comment with its author, the comment it replies to, how many replies it has and every report of it.",
	http: { method: "GET", path: "/comments/{id}" },
	readOnly: true,
	input: z.object({ id: commentId }),
	output: CommentSchema.extend({
		replies: z.number().int().describe("Replies to it, whatever their state"),
		parent: z.object({ id: z.string(), authorName: z.string(), snippet: z.string() }).nullable(),
		reports: z.array(ReportSchema),
	}),
	handler: async ({ account, input }) => {
		const comment = await findComment(account, input.id);
		const [output, replies, parent, reports] = await Promise.all([
			toOutput(account, comment),
			Comment.countDocuments(scoped(account, { parentId: comment._id })),
			comment.parentId ? Comment.findOne(scoped(account, { _id: comment.parentId })).select({ authorName: 1, body: 1 }).lean() : null,
			CommentReport.find(scoped(account, { commentId: comment._id })).sort({ createdAt: -1, _id: -1 }).limit(100).lean(),
		]);
		return {
			...output,
			replies,
			parent: parent ? { id: String(parent._id), authorName: parent.authorName, snippet: toSnippet(parent.body, 160) } : null,
			reports: await hydrateReports(account, reports),
		};
	},
});

const moderateCommentAction = defineAction({
	name: "moderate_comment",
	title: "Approve, hide or remove a comment",
	group: GROUP,
	description: `Decides a comment. approve: shows a held, hidden or removed comment on the issue's page, and dismisses its reports. hide: takes it off the page, kept, and you can approve it again. remove: takes it off the page for good unless you approve it again. Hiding and removing need a reason (${MAX_REASON_CHARS} characters at most): the author always sees it, on the issue's page and in an email through the usual sending path (suppressed addresses and blocked accounts get none). Hiding or removing settles the comment's open reports as actioned. A comment its author deleted can't be approved.`,
	http: { method: "POST", path: "/comments/{id}/moderate" },
	idempotent: true,
	example: { action: "hide", reason: "Off topic for this thread" },
	input: z.object({
		id: commentId,
		action: z.enum(MODERATION_ACTIONS).describe("approve, hide or remove"),
		reason: reasonInput.optional().describe(`Required for hide and remove; the author reads it. ${MAX_REASON_CHARS} characters at most.`),
	}),
	output: CommentSchema,
	handler: async ({ account, input }) => toOutput(account, await moderateComment({ account, id: input.id, action: input.action, reason: input.reason })),
});

const setCommentSettings = defineAction({
	name: "set_comment_settings",
	tryWithoutPlan: true,
	title: "Set comment settings",
	group: GROUP,
	description: `Changes a newsletter's comment settings; send only what changes. enabled turns comments on or off for the web issues (off by default). who: everyone subscribed, or paid subscribers only. moderation: none, hold_links (a comment with a link waits for your review) or hold_all. notifyOwner: the digest email, at most one an hour. A comment is held with a reason you can read in list_comments. To change one issue, send its campaign ID and issueComments: on, off, or default to follow the newsletter; that works for a sent issue too, to close a thread. Comments need the newsletter's website on, and never show on an issue for paid subscribers only, whose page is a teaser. Readers sign in with a link emailed to them (no password), and a comment needs an active subscriber.`,
	http: { method: "PATCH", path: "/comments/settings" },
	idempotent: true,
	example: { enabled: true, moderation: "hold_links" },
	input: z.object({
		newsletter: newsletterInput,
		enabled: z.boolean().optional().describe("Comments on or off for the newsletter's web issues"),
		who: z.enum(COMMENT_WHO).optional().describe("everyone: any active subscriber. paid: paid subscribers only."),
		moderation: z.enum(COMMENT_MODERATION).optional().describe("none: comments show at once. hold_links: a comment with a link waits for you. hold_all: every comment waits for you."),
		notifyOwner: z.boolean().optional().describe("Whether you get the digest email, one an hour at most, about new comments and reports"),
		campaign: z.string().trim().min(1).max(100).optional().describe("An issue's campaign ID, to set its own word on comments with issueComments"),
		issueComments: z.enum(["on", "off", "default"]).optional().describe("on or off for that issue, or default to follow the newsletter again"),
	}),
	output: SettingsSchema.extend({ issue: IssueSchema.nullable().describe("The issue campaign named, after the change; else null") }),
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.newsletter);
		if ((input.campaign === undefined) !== (input.issueComments === undefined)) {
			throw actionError("validation_failed", "campaign and issueComments go together");
		}
		let campaign = null;
		if (input.campaign) {
			campaign = isObjectIdString(input.campaign) ? await Campaign.findOne(scoped(account, { _id: input.campaign, newsletterId: newsletter._id })).lean() : null;
			if (!campaign || campaign.status === "canceled") throw actionError("not_found", "Campaign not found");
		}
		const turnsOn = input.enabled === true || input.issueComments === "on";
		if (turnsOn && !newsletter.archiveEnabled) throw actionError("validation_failed", "Turn on the newsletter's website first: comments live on its issue pages");

		const set = {
			...(input.enabled !== undefined && { "comments.enabled": input.enabled }),
			...(input.who !== undefined && { "comments.who": input.who }),
			...(input.moderation !== undefined && { "comments.moderation": input.moderation }),
			...(input.notifyOwner !== undefined && { "comments.notifyOwner": input.notifyOwner }),
		};
		if (Object.keys(set).length > 0) await Newsletter.updateOne(scoped(account, { _id: newsletter._id }), { $set: set });
		if (campaign) {
			await Campaign.updateOne(
				scoped(account, { _id: campaign._id }),
				input.issueComments === "default" ? { $unset: { comments: 1 } } : { $set: { comments: input.issueComments } }
			);
		}
		if (Object.keys(set).length > 0 || campaign) refreshArchivePages();

		const fresh = await loadNewsletter(account, newsletter._id);
		const issue = campaign && (await Campaign.findOne(scoped(account, { _id: campaign._id })).lean());
		return {
			...toSettings(fresh),
			issue: issue ? { id: String(issue._id), subject: issue.subject ?? "", comments: issue.comments ?? null, isOn: areCommentsOn(fresh, issue) } : null,
		};
	},
});

const ContactBlockSchema = z.object({
	contactId: z.string(),
	email: z.string(),
	status: z.string().describe("Their subscription: blocking leaves it as it is"),
	isBlocked: z.boolean(),
	reason: z.string().nullable().describe("What they read when they try to comment"),
	blockedAt: dateOutput,
});

function toBlock(contact) {
	return {
		contactId: String(contact._id),
		email: contact.email,
		status: contact.status,
		isBlocked: Boolean(contact.community?.blocked),
		reason: contact.community?.blockedReason ?? null,
		blockedAt: toIso(contact.community?.blockedAt),
	};
}

const blockCommenterAction = defineAction({
	name: "block_commenter",
	title: "Block a commenter",
	group: GROUP,
	description: `Turns commenting off for one subscriber, with a reason (${MAX_REASON_CHARS} characters at most) that they read when they try to comment. Their contact stays subscribed and keeps getting every email; their earlier comments stay as they are, and you can hide or remove them with moderate_comment. Repeating it changes the reason.`,
	http: { method: "POST", path: "/comments/block" },
	idempotent: true,
	example: { contact: "6650f1c2e9b1d4a012345678", reason: "Personal attacks in the last thread" },
	input: z.object({ contact: idInput("contact"), reason: reasonInput }),
	output: ContactBlockSchema,
	handler: async ({ account, input }) => toBlock(await blockCommenter({ account, contactId: input.contact, reason: input.reason })),
});

const unblockCommenterAction = defineAction({
	name: "unblock_commenter",
	title: "Unblock a commenter",
	group: GROUP,
	description: "Lets a blocked subscriber comment again.",
	http: { method: "POST", path: "/comments/unblock" },
	idempotent: true,
	example: { contact: "6650f1c2e9b1d4a012345678" },
	input: z.object({ contact: idInput("contact") }),
	output: ContactBlockSchema,
	handler: async ({ account, input }) => toBlock(await unblockCommenter({ account, contactId: input.contact })),
});

const listCommentReports = defineAction({
	name: "list_comment_reports",
	title: "List comment reports",
	group: GROUP,
	description: `Lists the reports subscribers made of a newsletter's comments, newest first, ${LIST_PAGE} a page: who reported which comment and what they said. Nothing happens to a reported comment by itself: you decide with moderate_comment, which settles its open reports. Pass nextCursor back as cursor for the next page.`,
	http: { method: "GET", path: "/comments/reports" },
	readOnly: true,
	example: { status: "open" },
	input: z.object({
		newsletter: newsletterInput,
		status: z.enum(REPORT_STATUSES).optional().describe("Only reports in this state; open ones need you"),
		limit: z.number().int().min(1).max(100).optional().describe(`Reports per page, ${LIST_PAGE} by default, 100 at most`),
		cursor: z.string().max(200).optional().describe("nextCursor from the previous page"),
	}),
	output: z.object({ reports: z.array(ReportSchema), nextCursor: z.string().nullable().describe("null on the last page"), open: z.number().int().describe("Reports waiting for you") }),
	handler: async ({ account, input }) => {
		const newsletter = await findNewsletter(account, input.newsletter, { _id: 1 });
		const limit = input.limit ?? LIST_PAGE;
		const filter = scoped(account, { newsletterId: newsletter._id, ...(input.status && { status: input.status }), ...(input.cursor && afterCursor(input.cursor, "createdAt")) });
		const found = await CommentReport.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean();
		const page = found.slice(0, limit);
		const last = page.at(-1);
		return {
			reports: await hydrateReports(account, page),
			nextCursor: found.length > limit ? encodeCursor(last.createdAt, last._id) : null,
			open: await CommentReport.countDocuments(scoped(account, { newsletterId: newsletter._id, status: "open" })),
		};
	},
});

export const commentActions = [listComments, getComment, moderateCommentAction, setCommentSettings, blockCommenterAction, unblockCommenterAction, listCommentReports];
