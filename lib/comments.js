import "server-only";
import { emitRecordEvent } from "@/lib/record-events";
import crypto from "node:crypto";
import { revalidatePath } from "@/lib/runtime-hooks";
import { cleanCommentBody, normalizeForCompare } from "@/lib/comment-body";
import {
	DELETED_READER,
	MAX_PUBLIC_ROOTS,
	canEditComment,
	decideCommentStatus,
	deriveDisplayName,
	getCommentAccess,
	getCommentSettings,
	getEditDeadline,
	normalizeDisplayName,
} from "@/lib/comment-rules";
import { isRateLimited } from "@/lib/rate-limit";
import { limitKey } from "@/lib/reader-links";
import { isObjectIdString } from "@/lib/validation";
import { getReplyRules } from "@/lib/reply-rule-settings";
import { isBlocked, hasActiveSubscription } from "@/lib/account-state";
import Account from "@/models/Account";
import Campaign from "@/models/Campaign";
import Newsletter from "@/models/Newsletter";
import Comment from "@/models/Comment";
import CommentReport from "@/models/CommentReport";
import Contact from "@/models/Contact";

// What readers do with comments: write, change, delete and report their own, and read an issue's. Every function takes the
// newsletter and issue the page showed and a contact already proven by a signed link (lib/reader-session.js), and answers
// { ok: true, ... } or { ok: false, code, message } with words for the reader. Nothing here returns a reader's email.
const PER_CONTACT = { name: "comment-contact", limit: 6, window: "10 m" };
const PER_CONTACT_DAY = { name: "comment-contact-day", limit: 40, window: "1 d" };
const PER_IP = { name: "comment-ip", limit: 20, window: "1 h" };
const EDITS = { name: "comment-edit", limit: 10, window: "10 m" };
const REPORTS = { name: "comment-report", limit: 10, window: "1 h" };
const MAX_REPORT_REASON = 300;
const MAX_PUBLIC_ROWS = 1000;
const BUSY_MESSAGE = "You're commenting quickly. Try again in a few minutes.";

export function failure(code, message) {
	return { ok: false, code, message };
}

function hashBody(campaignId, body) {
	return crypto.createHash("sha256").update(`${campaignId}:${normalizeForCompare(body)}`).digest("base64url").slice(0, 22);
}

// The issue's page is cached: a change to what it shows renews it.
export function revalidateIssue(newsletter, campaign) {
	if (newsletter?.slug && campaign?.archiveSlug) revalidatePath(`/archive/${newsletter.slug}/p/${campaign.archiveSlug}`);
}

function refreshArchive() {
	revalidatePath("/archive/[slug]", "layout");
}

async function isBusy(contact, ip, { edits = false } = {}) {
	const key = String(contact._id);
	if (edits) return isRateLimited({ ...EDITS, key });
	return (
		(await isRateLimited({ ...PER_CONTACT, key })) ||
		(await isRateLimited({ ...PER_CONTACT_DAY, key })) ||
		(await isRateLimited({ ...PER_IP, key: String(ip ?? "unknown") }))
	);
}

// The name a comment goes out under: the one the reader set, or, on their first comment, the one they chose now.
function resolveName({ contact, displayName, newsletter }) {
	const stored = contact.community?.displayName;
	if (contact.community?.nameLocked && stored) return { name: stored, isNew: false };
	const chosen = String(displayName ?? "").trim() ? displayName : (stored ?? deriveDisplayName(contact.email));
	const { name, problem } = normalizeDisplayName(chosen, newsletter);
	return problem ? { problem } : { name, isNew: true };
}

async function currentCommentContext({ newsletter, campaign, contact, checkReader }) {
	const [fresh, issue, reader, account] = await Promise.all([
		Newsletter.findOne({ accountId: newsletter.accountId, _id: newsletter._id }).lean(),
		Campaign.findOne({ accountId: newsletter.accountId, newsletterId: newsletter._id, _id: campaign._id }).lean(),
		Contact.findOne({ accountId: newsletter.accountId, newsletterId: newsletter._id, _id: contact?._id }).lean(),
		Account.findById(newsletter.accountId).lean(),
	]);
	if (!fresh || !issue || !reader || !account || isBlocked(account) || !hasActiveSubscription(account) || (checkReader && !await checkReader())) return null;
	return { newsletter: fresh, campaign: issue, contact: reader };
}

function decisionSource(context) {
	return JSON.stringify({ rules: getReplyRules(context.newsletter), comments: getCommentSettings(context.newsletter), issue: [context.campaign.status, context.campaign.comments, context.campaign.audience] });
}

const CHANGED = "The comment or its rules changed. Reload the page and try again.";
const CONSENT = "Read the current Reply Rules and agree to AI processing before posting. Reload the page if the notice is missing.";

async function decideReply(context, body, consent) {
	const settings = getReplyRules(context.newsletter);
	if (settings.enabled && consent !== settings.revision) return { failure: failure("ai_consent_required", CONSENT) };
	const baseline = decideCommentStatus({ moderation: getCommentSettings(context.newsletter).moderation, body });
	if (!settings.enabled || baseline.status !== "published") return { decision: baseline, consented: settings.enabled, exampleConsented: settings.enabled && settings.learnFromHides };
	const { classifyReply } = await import("@/lib/reply-rules");
	const decision = await classifyReply(context.newsletter, body);
	return { decision, consented: true, exampleConsented: settings.learnFromHides };
}

export async function postComment({ newsletter, campaign, contact, body: rawBody, parentId, displayName, ip, replyRulesConsent, checkReader }) {
	const original = { newsletter, campaign, contact, checkReader };
	const context = await currentCommentContext(original);
	if (!context) return failure("comment_changed", CHANGED);
	({ newsletter, campaign, contact } = context);
	const access = getCommentAccess({ newsletter, campaign, contact });
	if (!access.ok) return failure(access.code, access.message);
	const { body, problem: bodyProblem } = cleanCommentBody(rawBody);
	if (bodyProblem) return failure("invalid_body", bodyProblem);
	const named = resolveName({ contact, displayName, newsletter });
	if (named.problem) return failure("invalid_name", named.problem);
	if (await isBusy(contact, ip)) return failure("rate_limited", BUSY_MESSAGE);

	const { accountId } = newsletter;
	let parent = null;
	if (parentId) {
		parent = isObjectIdString(String(parentId)) ? await Comment.findOne({ accountId, campaignId: campaign._id, _id: parentId }).lean() : null;
		if (!parent || parent.status !== "published" || parent.parentId) return failure("no_parent", "The comment you're replying to isn't there anymore.");
	}
	const bodyHash = hashBody(campaign._id, body);
	if (await Comment.exists({ accountId, campaignId: campaign._id, authorId: contact._id, bodyHash })) {
		return failure("duplicate", "You already posted this.");
	}

	const result = await decideReply(context, body, replyRulesConsent);
	if (result.failure) return result.failure;
	const current = await currentCommentContext(original);
	if (!current || !getCommentAccess(current).ok || decisionSource(current) !== decisionSource(context)) return failure("comment_changed", CHANGED);
	if (parent && !await Comment.exists({ accountId, campaignId: campaign._id, _id: parent._id, status: "published" })) return failure("no_parent", "The comment you're replying to isn't there anymore.");
	const { status, reason, metadata } = result.decision;
	const now = new Date();
	const comment = await Comment.create({
		accountId,
		newsletterId: newsletter._id,
		campaignId: campaign._id,
		...(parent && { parentId: parent._id }),
		authorId: contact._id,
		authorName: named.name,
		body,
		status,
		...(reason && { reason, decidedBy: "rules", decidedAt: now }),
		bodyHash,
		...(result.consented && { replyRuleConsentAt: now, replyRuleConsentHash: bodyHash, replyRuleExampleConsent: result.exampleConsented }),
		...(metadata && { replyRuleDecision: metadata }),
		ipHash: limitKey(ip ?? "unknown"),
		notifyPending: true,
	});
	if (named.isNew) {
		await Contact.updateOne(
			{ accountId, _id: contact._id, "community.nameLocked": { $ne: true } },
			{ $set: { "community.displayName": named.name, "community.nameLocked": true } }
		);
	}
	await emitRecordEvent("comment.created", { accountId, newsletterId: newsletter._id, id: comment._id, parentId: campaign._id });
	if (status === "published") revalidateIssue(newsletter, campaign);
	return { ok: true, comment: comment.toObject() };
}

async function findOwnComment({ newsletter, campaign, contact, commentId }) {
	if (!isObjectIdString(String(commentId ?? ""))) return null;
	return Comment.findOne({ accountId: newsletter.accountId, campaignId: campaign._id, authorId: contact._id, _id: commentId }).lean();
}

// For a few minutes after writing it. A change is judged by the newsletter's rules again: adding a link to a comment under
// "hold links" holds it, and taking the link out of a held one lets it through.
export async function editComment({ newsletter, campaign, contact, commentId, body: rawBody, replyRulesConsent, checkReader }) {
	const original = { newsletter, campaign, contact, checkReader };
	const context = await currentCommentContext(original);
	if (!context) return failure("comment_changed", CHANGED);
	({ newsletter, campaign, contact } = context);
	const access = getCommentAccess({ newsletter, campaign, contact });
	if (!access.ok) return failure(access.code, access.message);
	const comment = await findOwnComment({ newsletter, campaign, contact, commentId });
	if (!comment) return failure("not_found", "That comment isn't there anymore.");
	if (!canEditComment(comment)) return failure("edit_window", "You can change a comment for 15 minutes after posting it.");
	const { body, problem } = cleanCommentBody(rawBody);
	if (problem) return failure("invalid_body", problem);
	if (await isBusy(contact, null, { edits: true })) return failure("rate_limited", BUSY_MESSAGE);

	const { accountId } = newsletter;
	const bodyHash = hashBody(campaign._id, body);
	if (bodyHash !== comment.bodyHash && (await Comment.exists({ accountId, campaignId: campaign._id, authorId: contact._id, bodyHash, _id: { $ne: comment._id } }))) {
		return failure("duplicate", "You already posted this.");
	}
	const result = await decideReply(context, body, replyRulesConsent);
	if (result.failure) return result.failure;
	const current = await currentCommentContext(original);
	if (!current || !getCommentAccess(current).ok || decisionSource(current) !== decisionSource(context)) return failure("comment_changed", CHANGED);
	const { decision } = result;
	const now = new Date();
	const set = { body, bodyHash, edited: true, editedAt: now, status: decision.status };
	const unset = {};
	if (result.consented) Object.assign(set, { replyRuleConsentAt: now, replyRuleConsentHash: bodyHash, replyRuleExampleConsent: result.exampleConsented });
	else Object.assign(unset, { replyRuleConsentAt: 1, replyRuleConsentHash: 1, replyRuleExampleConsent: 1 });
	if (decision.metadata) set.replyRuleDecision = decision.metadata;
	else unset.replyRuleDecision = 1;
	if (decision.status !== "published") Object.assign(set, { reason: decision.reason, decidedBy: "rules", decidedAt: now, ...(comment.status === "published" && { notifyPending: true }) });
	else Object.assign(unset, { reason: 1, decidedBy: 1, decidedAt: 1 });
	const changed = await Comment.updateOne({ accountId, _id: comment._id, bodyHash: comment.bodyHash, status: comment.status, updatedAt: comment.updatedAt }, { $set: set, ...(Object.keys(unset).length > 0 && { $unset: unset }) });
	if (!changed.matchedCount) return failure("comment_changed", CHANGED);
	await emitRecordEvent("comment.updated", { accountId, newsletterId: newsletter._id, id: comment._id, parentId: campaign._id });
	if (comment.status === "published" || decision.status === "published") revalidateIssue(newsletter, campaign);
	return { ok: true, status: decision.status };
}

// Always allowed, whatever the newsletter's settings: the words go. A comment with replies stays as a note that it was
// deleted, so the replies keep their place.
export async function deleteOwnComment({ newsletter, campaign, contact, commentId }) {
	const comment = await findOwnComment({ newsletter, campaign, contact, commentId });
	if (!comment || (comment.status === "removed" && comment.decidedBy === "author")) return failure("not_found", "That comment isn't there anymore.");
	const { accountId } = newsletter;
	const replies = await Comment.countDocuments({ accountId, parentId: comment._id });
	if (replies === 0) {
		await Comment.deleteOne({ accountId, _id: comment._id });
		await CommentReport.deleteMany({ accountId, commentId: comment._id });
	} else {
		await Comment.updateOne(
			{ accountId, _id: comment._id },
			{
				$set: { status: "removed", reason: "Deleted by its author.", decidedBy: "author", decidedAt: new Date(), body: "", reports: 0 },
				$unset: { bodyHash: 1, notifyPending: 1, replyRuleConsentAt: 1, replyRuleConsentHash: 1, replyRuleExampleConsent: 1, replyRuleDecision: 1 },
			}
		);
		await CommentReport.updateMany({ accountId, commentId: comment._id, status: "open" }, { $set: { status: "dismissed", resolvedAt: new Date() }, $unset: { notifyPending: 1 } });
	}
	await emitRecordEvent("comment.deleted", { accountId, newsletterId: newsletter._id, id: comment._id, parentId: campaign._id });
	revalidateIssue(newsletter, campaign);
	return { ok: true };
}

// A subscriber who can see the comment says it breaks the newsletter's rules; the owner decides. Once a reader, once a
// comment. Nothing happens to the comment by itself.
export async function reportComment({ newsletter, campaign, contact, commentId, reason }) {
	if (contact?.status !== "active") return failure("not-subscribed", "Only subscribers can report a comment.");
	if (!isObjectIdString(String(commentId ?? ""))) return failure("not_found", "That comment isn't there anymore.");
	if (await isRateLimited({ ...REPORTS, key: String(contact._id) })) return failure("rate_limited", "You've sent several reports. Try again later.");
	const { accountId } = newsletter;
	const comment = await Comment.findOne({ accountId, campaignId: campaign._id, _id: commentId }).lean();
	if (!comment || comment.status !== "published") return failure("not_found", "That comment isn't there anymore.");
	if (String(comment.authorId) === String(contact._id)) return failure("own", "This is your own comment.");
	try {
		await CommentReport.create({
			accountId,
			newsletterId: newsletter._id,
			campaignId: campaign._id,
			commentId: comment._id,
			reporterId: contact._id,
			...(String(reason ?? "").trim() && { reason: String(reason).trim().slice(0, MAX_REPORT_REASON) }),
			notifyPending: true,
		});
	} catch (error) {
		if (error?.code === 11000) return { ok: true, already: true };
		throw error;
	}
	await Comment.updateOne({ accountId, _id: comment._id }, { $inc: { reports: 1 } });
	return { ok: true };
}

function toPublicComment(comment) {
	return {
		id: String(comment._id),
		authorName: comment.authorName,
		body: comment.body,
		createdAt: new Date(comment.createdAt).toISOString(),
		edited: Boolean(comment.edited),
		replies: [],
	};
}

// What an issue's page shows everyone: the published comments in the order they were written, replies under their comment.
// A comment that is gone but has replies shows as a note. Never an author's ID or email, only the display name.
export async function listPublicComments(newsletter, campaign) {
	const { accountId } = newsletter;
	const rows = await Comment.find({ accountId, campaignId: campaign._id, status: "published" })
		.sort({ createdAt: 1, _id: 1 })
		.limit(MAX_PUBLIC_ROWS)
		.lean();
	const nodes = new Map(rows.map((row) => [String(row._id), toPublicComment(row)]));
	const roots = rows.filter((row) => !row.parentId).map((row) => nodes.get(String(row._id)));
	const orphanIds = [...new Set(rows.filter((row) => row.parentId && !nodes.has(String(row.parentId))).map((row) => String(row.parentId)))];
	if (orphanIds.length > 0) {
		const gone = await Comment.find({ accountId, campaignId: campaign._id, _id: { $in: orphanIds } }).select({ createdAt: 1 }).lean();
		for (const row of gone) {
			const note = { id: String(row._id), isGone: true, createdAt: new Date(row.createdAt).toISOString(), replies: [] };
			nodes.set(note.id, note);
			roots.push(note);
		}
	}
	for (const row of rows) if (row.parentId) nodes.get(String(row.parentId))?.replies.push(nodes.get(String(row._id)));
	roots.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
	return { total: rows.length, comments: roots.slice(-MAX_PUBLIC_ROOTS), isTrimmed: roots.length > MAX_PUBLIC_ROOTS };
}

// What the signed-in reader's browser needs to know: whether they can comment and why not, the name they'll use, their
// own comments on this issue with the reason for any that isn't showing, which comments they reported.
export async function getViewerState({ newsletter, campaign, contact, now = Date.now() }) {
	const access = getCommentAccess({ newsletter, campaign, contact, now });
	const [mine, reports] = await Promise.all([
		Comment.find({ accountId: newsletter.accountId, campaignId: campaign._id, authorId: contact._id }).sort({ createdAt: 1, _id: 1 }).lean(),
		CommentReport.find({ accountId: newsletter.accountId, campaignId: campaign._id, reporterId: contact._id }).select({ commentId: 1 }).lean(),
	]);
	return {
		replyRules: getReplyRules(await Newsletter.findOne({ accountId: newsletter.accountId, _id: newsletter._id }).select("replyRules").lean()),
		access: { ok: access.ok, code: access.code ?? null, message: access.message ?? null },
		name: {
			current: contact.community?.displayName ?? null,
			suggested: deriveDisplayName(contact.email),
			isLocked: Boolean(contact.community?.nameLocked && contact.community?.displayName),
		},
		own: mine.map((comment) => {
			const canEdit = canEditComment(comment, now);
			return {
				id: String(comment._id),
				parentId: comment.parentId ? String(comment.parentId) : null,
				status: comment.status,
				reason: comment.reason ?? null,
				decidedBy: comment.decidedBy ?? null,
				body: comment.body,
				createdAt: new Date(comment.createdAt).toISOString(),
				editableUntil: canEdit ? getEditDeadline(comment).toISOString() : null,
			};
		}),
		reported: reports.map(({ commentId }) => String(commentId)),
	};
}

// A deleted contact's comments stay for the replies' sake, as the "Deleted reader"'s: nothing links them to a person any
// more, and the reports they made go.
export async function anonymizeComments({ accountId, contactId }) {
	await Comment.updateMany({ accountId, authorId: contactId }, { $set: { authorName: DELETED_READER }, $unset: { authorId: 1, ipHash: 1, bodyHash: 1, replyRuleConsentAt: 1, replyRuleConsentHash: 1, replyRuleExampleConsent: 1, replyRuleDecision: 1 } });
	const reports = await CommentReport.find({ accountId, reporterId: contactId }).select({ commentId: 1, status: 1 }).lean();
	for (const { commentId, status } of reports) if (status === "open") await Comment.updateOne({ accountId, _id: commentId, reports: { $gt: 0 } }, { $inc: { reports: -1 } });
	await CommentReport.deleteMany({ accountId, reporterId: contactId });
	refreshArchive();
}
