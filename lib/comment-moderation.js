import "server-only";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { scoped } from "@/lib/account-scope";
import { actionError } from "@/lib/actions/errors";
import { MAX_REASON_CHARS } from "@/lib/comment-rules";
import { notifyAuthorOfDecision, notifyReply } from "@/lib/comment-notify";
import { revalidateIssue } from "@/lib/comments";
import { isObjectIdString } from "@/lib/validation";
import Campaign from "@/models/Campaign";
import Comment from "@/models/Comment";
import CommentReport from "@/models/CommentReport";
import Contact from "@/models/Contact";
import Newsletter from "@/models/Newsletter";

// What the newsletter's owner does with comments: the moderation rules are theirs. Hiding and removing need a reason, which
// the comment's author always sees (on the issue's page and by email). Every function takes the account and throws action
// errors, since it runs from the actions (lib/actions/comments.js).
export const MODERATION_ACTIONS = ["approve", "hide", "remove"];

export function cleanReason(value, { isRequired }) {
	const reason = String(value ?? "").replace(/\s+/g, " ").trim();
	if (isRequired && !reason) throw actionError("validation_failed", "reason: say why, the author will read it");
	if (reason.length > MAX_REASON_CHARS) throw actionError("validation_failed", `reason: ${MAX_REASON_CHARS} characters at most`);
	return reason;
}

export async function findComment(account, id) {
	const comment = isObjectIdString(String(id ?? "")) ? await Comment.findOne(scoped(account, { _id: id })).lean() : null;
	if (!comment) throw actionError("not_found", "Comment not found");
	return comment;
}

// approve: brings a held, hidden or removed comment onto the page, and settles its reports as dismissed. hide: off the page,
// kept, and the owner can bring it back. remove: off the page, for good unless approved again. A comment its author deleted
// is gone: nothing is left to approve.
export async function moderateComment({ account, id, action, reason: rawReason }) {
	const comment = await findComment(account, id);
	const reason = cleanReason(rawReason, { isRequired: action !== "approve" });
	if (comment.status === "removed" && comment.decidedBy === "author") throw actionError("conflict", "Its author deleted this comment");
	const target = { approve: "published", hide: "hidden", remove: "removed" }[action];
	if (comment.status === "removed" && action === "hide") throw actionError("conflict", "This comment is removed: approve it to bring it back, or leave it removed");

	const now = new Date();
	const isNew = comment.status !== target;
	if (isNew) {
		await Comment.updateOne(scoped(account, { _id: comment._id }), {
			$set: { status: target, decidedBy: "creator", decidedAt: now, ...(action !== "approve" && { reason }) },
			$unset: { notifyPending: 1, ...(action === "approve" && { reason: 1 }) },
		});
	} else if (action !== "approve" && reason !== comment.reason) {
		await Comment.updateOne(scoped(account, { _id: comment._id }), { $set: { reason, decidedBy: "creator", decidedAt: now } });
	}
	await CommentReport.updateMany(scoped(account, { commentId: comment._id, status: "open" }), {
		$set: { status: action === "approve" ? "dismissed" : "actioned", resolvedAt: now },
		$unset: { notifyPending: 1 },
	});
	await Comment.updateOne(scoped(account, { _id: comment._id, reports: { $gt: 0 } }), { $set: { reports: 0 } });

	const [newsletter, campaign] = await Promise.all([
		Newsletter.findOne(scoped(account, { _id: comment.newsletterId })).lean(),
		Campaign.findOne(scoped(account, { _id: comment.campaignId })).select({ subject: 1, archiveSlug: 1 }).lean(),
	]);
	revalidateIssue(newsletter, campaign);
	const updated = await Comment.findOne(scoped(account, { _id: comment._id })).lean();
	if (isNew) {
		// After the response: an email's trouble is not the owner's.
		after(async () => {
			try {
				if (action === "approve") await notifyReply({ newsletter, campaign, comment: updated });
				else await notifyAuthorOfDecision({ newsletter, campaign, comment: updated, action });
			} catch (error) {
				console.error("[comments] Notice failed:", error.message);
			}
		});
	}
	return updated;
}

// Their contact stays subscribed and gets every email; only commenting is off, with the reason shown when they try.
export async function blockCommenter({ account, contactId, reason: rawReason }) {
	const reason = cleanReason(rawReason, { isRequired: true });
	const contact = isObjectIdString(String(contactId ?? "")) ? await Contact.findOne(scoped(account, { _id: contactId })).lean() : null;
	if (!contact) throw actionError("not_found", "Contact not found");
	await Contact.updateOne(scoped(account, { _id: contact._id }), {
		$set: { "community.blocked": true, "community.blockedReason": reason, "community.blockedAt": new Date() },
	});
	return Contact.findOne(scoped(account, { _id: contact._id })).lean();
}

export async function unblockCommenter({ account, contactId }) {
	const contact = isObjectIdString(String(contactId ?? "")) ? await Contact.findOne(scoped(account, { _id: contactId })).lean() : null;
	if (!contact) throw actionError("not_found", "Contact not found");
	await Contact.updateOne(scoped(account, { _id: contact._id }), { $unset: { "community.blocked": 1, "community.blockedReason": 1, "community.blockedAt": 1 } });
	return Contact.findOne(scoped(account, { _id: contact._id })).lean();
}

// The pages show the settings in force (comments on or off, the sign-in's wording), so a change renews them all.
export function refreshArchivePages() {
	revalidatePath("/archive/[slug]", "layout");
}
