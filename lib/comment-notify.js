import { getReaderText } from "@/lib/reader-languages";
import "server-only";
import { findOwnerEmail } from "@/lib/accounts";
import { toSnippet } from "@/lib/comment-body";
import { getCommentSettings } from "@/lib/comment-rules";
import { getAppUrl } from "@/lib/config";
import { canSendPlatformEmail, sendPlatformEmail } from "@/lib/platform-email";
import { isRateLimited } from "@/lib/rate-limit";
import { getEmailCommentUrl, getRepliesOffUrl } from "@/lib/reader-links";
import { sendTransactionalEmail } from "@/lib/sending";
import Campaign from "@/models/Campaign";
import Comment from "@/models/Comment";
import CommentReport from "@/models/CommentReport";
import Contact from "@/models/Contact";
import Newsletter from "@/models/Newsletter";

// The emails comments cause, and none that pushes anyone back: the owner hears about new comments and reports in one digest
// an hour at most, however many come; an author hears once about a reply to their comment, within a daily limit, and once
// about a comment the owner hid or removed, with the reason. Readers' emails go through the sending path (suppression,
// account blocks); the owner's through FlockStack's own emails.
const DIGEST_GAP_MS = 60 * 60_000;
const DIGEST_ITEMS = 8;
const PENDING_LIMIT = 200;
const REPLY_PER_READER = { name: "comment-reply-reader", limit: 3, window: "1 d" };
const REPLY_PER_NEWSLETTER = { name: "comment-reply-newsletter", limit: 30, window: "1 h" };
const DECISION_PER_READER = { name: "comment-decision-reader", limit: 5, window: "1 d" };

function log(message, error) {
	console.error(`[comments] ${message}:`, error.message);
}

function issueTitle(campaign) {
	return campaign?.subject?.trim() || "an issue";
}

async function findSubjects(accountId, campaignIds) {
	const ids = [...new Set(campaignIds.map(String))];
	const campaigns = ids.length > 0 ? await Campaign.find({ accountId, _id: { $in: ids } }).select({ subject: 1 }).lean() : [];
	return new Map(campaigns.map((campaign) => [String(campaign._id), issueTitle(campaign)]));
}

async function clearPending(accountId, comments, reports) {
	if (comments.length > 0) await Comment.updateMany({ accountId, _id: { $in: comments.map(({ _id }) => _id) } }, { $unset: { notifyPending: 1 } });
	if (reports.length > 0) await CommentReport.updateMany({ accountId, _id: { $in: reports.map(({ _id }) => _id) } }, { $unset: { notifyPending: 1 } });
}

function compose({ newsletter, comments, reports, subjects, authors }) {
	const held = comments.filter(({ status }) => status === "held");
	const rest = comments.filter(({ status }) => status !== "held");
	const issue = (id) => subjects.get(String(id)) ?? "an issue";
	const lines = [
		`${comments.length} new ${comments.length === 1 ? "comment" : "comments"}${held.length > 0 ? `, ${held.length} waiting for your review` : ""}${reports.length > 0 ? `, ${reports.length} new ${reports.length === 1 ? "report" : "reports"}` : ""} on ${newsletter.name}.`,
	];
	if (held.length > 0) {
		lines.push("", "Waiting for your review:");
		for (const comment of held.slice(0, DIGEST_ITEMS)) {
			lines.push(`- ${comment.authorName} on "${issue(comment.campaignId)}": "${toSnippet(comment.body)}"`, `  Held because: ${comment.reason}`);
		}
	}
	if (reports.length > 0) {
		lines.push("", "Reported:");
		for (const report of reports.slice(0, DIGEST_ITEMS)) {
			const target = authors.get(String(report.commentId));
			lines.push(
				`- ${authors.get(`reporter:${report.reporterId}`) ?? "A reader"} reported ${target?.authorName ?? "a comment"} on "${issue(report.campaignId)}": "${toSnippet(target?.body ?? "")}"`,
				`  ${report.reason ? `Their reason: ${report.reason}` : "They gave no reason."}`
			);
		}
	}
	if (rest.length > 0) {
		lines.push("", "New:");
		for (const comment of rest.slice(0, DIGEST_ITEMS)) lines.push(`- ${comment.authorName} on "${issue(comment.campaignId)}": "${toSnippet(comment.body)}"`);
	}
	lines.push(
		"",
		`Review, approve, hide or remove them on the Comments page: ${getAppUrl()}/comments`,
		"",
		"You get at most one of these an hour. You can turn them off on the Comments page."
	);
	return lines.join("\n");
}

// The owner's digest for one newsletter: what is new since the last one, if it has been an hour. The first comment after a
// quiet hour is told at once; the ones that follow wait for the hour to pass (the hourly cron, or the next comment after it).
export async function sendCommentDigest({ accountId, newsletterId, now = new Date() }) {
	const newsletter = await Newsletter.findOne({ accountId, _id: newsletterId }).lean();
	if (!newsletter) return { skipped: "no newsletter" };
	const [comments, reports] = await Promise.all([
		Comment.find({ accountId, newsletterId, notifyPending: true }).sort({ createdAt: 1 }).limit(PENDING_LIMIT).lean(),
		CommentReport.find({ accountId, newsletterId, notifyPending: true }).sort({ createdAt: 1 }).limit(PENDING_LIMIT).lean(),
	]);
	if (comments.length === 0 && reports.length === 0) return { skipped: "nothing new" };
	if (!getCommentSettings(newsletter).notifyOwner) {
		await clearPending(accountId, comments, reports);
		return { skipped: "turned off" };
	}
	if (!canSendPlatformEmail()) return { skipped: "no way to send" };

	const { matchedCount } = await Newsletter.updateOne(
		{ accountId, _id: newsletterId, $or: [{ "comments.digestSentAt": { $exists: false } }, { "comments.digestSentAt": { $lte: new Date(now.getTime() - DIGEST_GAP_MS) } }] },
		{ $set: { "comments.digestSentAt": now } }
	);
	if (matchedCount === 0) return { skipped: "sent less than an hour ago" };

	try {
		const to = await findOwnerEmail(accountId);
		if (!to) return { skipped: "no owner" };
		const [subjects, targets, reporters] = await Promise.all([
			findSubjects(accountId, [...comments, ...reports].map(({ campaignId }) => campaignId)),
			reports.length > 0 ? Comment.find({ accountId, _id: { $in: reports.map(({ commentId }) => commentId) } }).select({ authorName: 1, body: 1 }).lean() : [],
			reports.length > 0 ? Contact.find({ accountId, _id: { $in: reports.map(({ reporterId }) => reporterId) } }).select({ "community.displayName": 1 }).lean() : [],
		]);
		const authors = new Map(targets.map((comment) => [String(comment._id), comment]));
		for (const contact of reporters) authors.set(`reporter:${contact._id}`, contact.community?.displayName ?? "A reader");
		const count = comments.length + reports.length;
		await sendPlatformEmail({
			to,
			subject: `[FlockStack] ${count} new ${count === 1 ? "item" : "items"} to look at on ${newsletter.name}`,
			text: compose({ newsletter, comments, reports, subjects, authors }),
		});
	} catch (error) {
		await Newsletter.updateOne({ accountId, _id: newsletterId }, { $unset: { "comments.digestSentAt": 1 } });
		throw error;
	}
	await clearPending(accountId, comments, reports);
	return { sent: true, comments: comments.length, reports: reports.length };
}

// The hourly cron: a digest for every newsletter with something new that the hour since its last one allows.
export async function sendCommentDigests({ now = new Date() } = {}) {
	const found = await Promise.all([
		Comment.find({ notifyPending: true }).setOptions({ crossAccount: true }).select({ accountId: 1, newsletterId: 1 }).limit(500).lean(),
		CommentReport.find({ notifyPending: true }).setOptions({ crossAccount: true }).select({ accountId: 1, newsletterId: 1 }).limit(500).lean(),
	]);
	const targets = new Map(found.flat().map(({ accountId, newsletterId }) => [`${accountId}:${newsletterId}`, { accountId, newsletterId }]));
	const result = { sent: 0, skipped: 0, failed: 0 };
	for (const target of targets.values()) {
		try {
			const outcome = await sendCommentDigest({ ...target, now });
			result[outcome.sent ? "sent" : "skipped"] += 1;
		} catch (error) {
			result.failed += 1;
			log("Digest failed", error);
		}
	}
	return result;
}

// After a reader posts: the owner's digest if it is due, and the reply email for a reply that shows.
export async function notifyAfterPost({ newsletter, campaign, comment }) {
	try {
		await sendCommentDigest({ accountId: newsletter.accountId, newsletterId: newsletter._id });
	} catch (error) {
		log("Digest failed", error);
	}
	try {
		if (comment.status === "published" && comment.parentId) await notifyReply({ newsletter, campaign, comment });
	} catch (error) {
		log("Reply email failed", error);
	}
}

async function findActiveReader(accountId, contactId) {
	const contact = contactId ? await Contact.findOne({ accountId, _id: contactId }).lean() : null;
	return contact?.status === "active" ? contact : null;
}

// Someone replied to a comment: its author is told once, unless they asked not to be, or they wrote the reply themselves.
export async function notifyReply({ newsletter, campaign, comment }) {
	const t = getReaderText(newsletter);
	if (!comment?.parentId || comment.status !== "published") return { skipped: "not a reply that shows" };
	const { accountId } = newsletter;
	const parent = await Comment.findOne({ accountId, _id: comment.parentId }).lean();
	if (!parent?.authorId || parent.status !== "published") return { skipped: "nobody to tell" };
	if (String(parent.authorId) === String(comment.authorId)) return { skipped: "their own reply" };
	const recipient = await findActiveReader(accountId, parent.authorId);
	if (!recipient || recipient.community?.repliesOff) return { skipped: "not wanted" };

	// Once per reply, whatever happens to the email: a retry loop must never turn into several.
	const { matchedCount } = await Comment.updateOne({ accountId, _id: comment._id, replyNotifiedAt: { $exists: false } }, { $set: { replyNotifiedAt: new Date() } });
	if (matchedCount === 0) return { skipped: "already told" };
	if ((await isRateLimited({ ...REPLY_PER_READER, key: String(recipient._id) })) || (await isRateLimited({ ...REPLY_PER_NEWSLETTER, key: String(newsletter._id) }))) {
		return { skipped: "rate limited" };
	}
	const reference = { contactId: recipient._id, newsletterId: newsletter._id };
	const url = getEmailCommentUrl(reference, newsletter, { issueSlug: campaign?.archiveSlug, commentId: comment._id });
	return sendTransactionalEmail({
		accountId,
		newsletterId: newsletter._id,
		to: recipient.email,
		kind: "comment",
		subject: t("{name} replied to your comment", { name: comment.authorName }),
		markdown: `${t("**{name}** replied to your comment on {title}.", { name: comment.authorName, title: issueTitle(campaign) })}\n\n[${t("Read the reply")}](${url})\n\n[${t("Stop emails about replies")}](${getRepliesOffUrl(reference, newsletter)})`,
		reason: t("You're getting this because someone replied to your comment on {name}. The link above turns these emails off.", { name: newsletter.name }),
	});
}

// The owner hid or removed a comment: its author reads why, wherever they look first.
export async function notifyAuthorOfDecision({ newsletter, campaign, comment, action }) {
	const t = getReaderText(newsletter);
	const { accountId } = newsletter;
	const recipient = await findActiveReader(accountId, comment.authorId);
	if (!recipient) return { skipped: "nobody to tell" };
	if (await isRateLimited({ ...DECISION_PER_READER, key: String(recipient._id) })) return { skipped: "rate limited" };
	const reference = { contactId: recipient._id, newsletterId: newsletter._id };
	const url = getEmailCommentUrl(reference, newsletter, { issueSlug: campaign?.archiveSlug });
	const verb = action === "hide" ? "hid" : "removed";
	return sendTransactionalEmail({
		accountId,
		newsletterId: newsletter._id,
		to: recipient.email,
		kind: "comment",
		subject: t(action === "hide" ? "Your comment on {title} was hidden" : "Your comment on {title} was removed", { title: issueTitle(campaign) }),
		markdown: t.language === "en" ? `${newsletter.name}'s owner ${verb} your comment on ${issueTitle(campaign)}.\n\nTheir reason: ${comment.reason}\n\n[See the discussion](${url})` : `${t(action === "hide" ? "The owner of {name} hid your comment on {title}." : "The owner of {name} removed your comment on {title}.", { name: newsletter.name, title: issueTitle(campaign) })}\n\n${t("Their reason: {reason}", { reason: comment.reason })}\n\n[${t("See the discussion")}](${url})`,
		reason: t("You're getting this because the owner of {name} acted on a comment you wrote.", { name: newsletter.name }),
	});
}
