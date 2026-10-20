"use server";

import { headers } from "next/headers";
import { after } from "next/server";
import { getArchiveIssue, getArchiveNewsletter } from "@/lib/archive-data";
import { notifyAfterPost } from "@/lib/comment-notify";
import { areCommentsOn } from "@/lib/comment-rules";
import { deleteOwnComment, editComment, getViewerState, postComment, reportComment } from "@/lib/comments";
import { connectDb } from "@/lib/db";
import { findOpenNewsletter } from "@/lib/public-newsletters";
import { getClientIp, isRateLimited } from "@/lib/rate-limit";
import { limitKey } from "@/lib/reader-links";
import { SIGNIN_PER_ADDRESS, SIGNIN_PER_IP, SIGNIN_SENT_MESSAGE } from "@/lib/reader-limits";
import { endReaderSession, findSessionReader, sendSignInEmail } from "@/lib/reader-session";
import { ARCHIVE_SLUG_PATTERN } from "@/lib/slug";
import { normalizeEmail } from "@/lib/validation";

const SIGNED_OUT = { error: "Sign in with your email to comment.", code: "signed-out" };
const NO_COMMENTS = { error: "This issue isn't taking comments.", code: "off" };

// "Sign in with your email" on an issue's page. The answer is the same for every address; the email goes out after the
// response, so the time it takes doesn't tell either.
export async function requestSignIn(_state, formData) {
	// People never see this field; bots fill in every input they find.
	if (formData.get("website")) return { ok: true, message: SIGNIN_SENT_MESSAGE };

	const email = normalizeEmail(formData.get("email"));
	if (!email) return { error: "Enter a valid email" };
	const slug = String(formData.get("newsletter") ?? "");
	const issueSlug = String(formData.get("p") ?? "");
	if (await isRateLimited({ ...SIGNIN_PER_IP, key: getClientIp(await headers()) })) {
		return { error: "Too many requests from your network. Try again in a few minutes." };
	}
	if (await isRateLimited({ ...SIGNIN_PER_ADDRESS, key: `${slug}:${limitKey(email)}` })) {
		return { error: "Too many requests for this address. Try again in an hour." };
	}

	after(async () => {
		try {
			await connectDb();
			const newsletter = await findOpenNewsletter({ slug, archiveEnabled: true });
			if (newsletter && ARCHIVE_SLUG_PATTERN.test(issueSlug)) await sendSignInEmail({ newsletter, email, issueSlug });
		} catch (error) {
			console.error("[reader] Sign-in email failed:", error.message);
		}
	});
	return { ok: true, message: SIGNIN_SENT_MESSAGE };
}

export async function signOutReader(slug) {
	await connectDb();
	const newsletter = await findOpenNewsletter({ slug: String(slug ?? ""), archiveEnabled: true });
	if (newsletter) await endReaderSession(newsletter);
	return { ok: true };
}

// The newsletter, the issue and the reader behind the browser's session, as the form named them. The issue is looked up the
// way its page was: a paid-only issue's page has no comments, so it has none to write.
async function resolveIssue(slug, post) {
	await connectDb();
	const newsletter = await getArchiveNewsletter(String(slug ?? ""));
	const campaign = newsletter && ARCHIVE_SLUG_PATTERN.test(String(post ?? "")) ? await getArchiveIssue(newsletter, String(post)) : null;
	if (!campaign || !areCommentsOn(newsletter, campaign)) return null;
	return { newsletter, campaign, contact: await findSessionReader(newsletter) };
}

// The page asks once it loads, when the browser has a session: who is reading, whether they can comment and what they
// wrote here, including what isn't showing and why.
export async function getViewer(slug, post) {
	const context = await resolveIssue(slug, post);
	if (!context) return { signedIn: false };
	if (!context.contact) {
		await endReaderSession(context.newsletter);
		return { signedIn: false };
	}
	return { signedIn: true, ...(await getViewerState(context)) };
}

export async function submitComment(_state, formData) {
	// People never see this field; bots fill in every input they find.
	if (formData.get("website")) return { ok: true, status: "published" };
	const context = await resolveIssue(formData.get("newsletter"), formData.get("p"));
	if (!context) return NO_COMMENTS;
	if (!context.contact) return SIGNED_OUT;
	const result = await postComment({
		...context,
		body: formData.get("body"),
		parentId: formData.get("parent") || undefined,
		displayName: formData.get("name"),
		ip: getClientIp(await headers()),
	});
	if (!result.ok) return { error: result.message, code: result.code };
	// After the response: the owner's digest, if one is due, and the email for a reply.
	after(() => notifyAfterPost({ newsletter: context.newsletter, campaign: context.campaign, comment: result.comment }));
	return { ok: true, id: String(result.comment._id), status: result.comment.status, reason: result.comment.reason ?? null };
}

export async function submitEdit(_state, formData) {
	const context = await resolveIssue(formData.get("newsletter"), formData.get("p"));
	if (!context) return NO_COMMENTS;
	if (!context.contact) return SIGNED_OUT;
	const result = await editComment({ ...context, commentId: formData.get("comment"), body: formData.get("body") });
	return result.ok ? { ok: true, status: result.status } : { error: result.message, code: result.code };
}

export async function submitDelete(_state, formData) {
	const context = await resolveIssue(formData.get("newsletter"), formData.get("p"));
	if (!context) return NO_COMMENTS;
	if (!context.contact) return SIGNED_OUT;
	const result = await deleteOwnComment({ ...context, commentId: formData.get("comment") });
	return result.ok ? { ok: true } : { error: result.message, code: result.code };
}

export async function submitReport(_state, formData) {
	const context = await resolveIssue(formData.get("newsletter"), formData.get("p"));
	if (!context) return NO_COMMENTS;
	if (!context.contact) return SIGNED_OUT;
	const result = await reportComment({ ...context, commentId: formData.get("comment"), reason: formData.get("reason") });
	return result.ok ? { ok: true } : { error: result.message, code: result.code };
}
