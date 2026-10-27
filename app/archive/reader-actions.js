"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { createReaderGiftLink, openGiftIssue } from "@/lib/gift-links";
import { connectDb } from "@/lib/db";
import { findOpenNewsletter } from "@/lib/public-newsletters";
import { getClientIp, isRateLimited } from "@/lib/rate-limit";
import { unlockIssueForReader } from "@/lib/reader-access";
import { limitKey } from "@/lib/reader-links";
import { SIGNIN_PER_ADDRESS, SIGNIN_PER_IP, SIGNIN_SENT_MESSAGE } from "@/lib/reader-limits";
import { endReaderSession, findSessionReader, sendSiteSignInEmail } from "@/lib/reader-session";
import { saveProfileName } from "@/lib/subscriber-center";
import { normalizeEmail } from "@/lib/validation";

const PROFILE_PER_IP = { name: "reader-profile-ip", limit: 20, window: "10 m" };

// The browser of a reader with a session asks for an issue's paid part. { unlocked: false } for everyone but a paid reader.
export async function unlockIssue(slug, post) {
	return unlockIssueForReader({ slug, post });
}

// A browser that arrived on a paid issue by a gift link asks for that one issue (lib/gift-links.js).
export async function openGift(slug, post, code) {
	return openGiftIssue({ slug, post, code });
}

// A paid reader's own link to the issue they are reading, within the owner's allowance.
export async function makeGiftLink(slug, post) {
	return createReaderGiftLink({ slug, post });
}

// "Email me a sign-in link" on the website's Sign in page. The answer is the same for every address; the email goes out
// after the response, so the time it takes doesn't tell either. Shares the comments' sign-in limits (lib/reader-limits.js).
export async function requestSiteSignIn(_state, formData) {
	// People never see this field; bots fill in every input they find.
	if (formData.get("website")) return { ok: true, message: SIGNIN_SENT_MESSAGE };

	const email = normalizeEmail(formData.get("email"));
	if (!email) return { error: "Enter a valid email" };
	const slug = String(formData.get("newsletter") ?? "");
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
			if (newsletter) await sendSiteSignInEmail({ newsletter, email });
		} catch (error) {
			console.error("[reader] Sign-in email failed:", error.message);
		}
	});
	return { ok: true, message: SIGNIN_SENT_MESSAGE };
}

// Sign out of the Subscriber Center: the session ends, and the reader lands on the newsletter's home page.
export async function signOutOfAccount(formData) {
	await connectDb();
	const newsletter = await findOpenNewsletter({ slug: String(formData.get("newsletter") ?? ""), archiveEnabled: true });
	if (!newsletter) redirect("/");
	await endReaderSession(newsletter);
	redirect(getArchiveUrls(newsletter).siteIndex);
}

// The name on the Subscriber Center's profile.
export async function saveProfile(_state, formData) {
	if (await isRateLimited({ ...PROFILE_PER_IP, key: getClientIp(await headers()) })) return { error: "Too many changes from your network. Try again in a few minutes." };
	await connectDb();
	const newsletter = await findOpenNewsletter({ slug: String(formData.get("newsletter") ?? ""), archiveEnabled: true });
	const contact = newsletter && (await findSessionReader(newsletter));
	if (!contact) return { error: "Your session ended. Sign in again." };
	const result = await saveProfileName({ newsletter, contact, name: formData.get("name") });
	return result.problem ? { error: result.problem } : { ok: true };
}

// Next.js validates the Origin for this server action; only a reader session can spend a free read.
export async function claimMeteredRead(slug, post, confirmed) {
	const result = await (await import("@/lib/metered-reading")).claimMeteredIssue({ slug, post, confirmed });
	return result.error ? result : unlockIssueForReader({ slug, post });
}

// A private reader choice; no owner API or key can opt someone in to a public membership badge.
export async function saveCommentBadge(_state, formData) {
	if (await isRateLimited({ ...PROFILE_PER_IP, key: getClientIp(await headers()) })) return { error: "Too many changes from your network. Try again in a few minutes." };
	await connectDb();
	const newsletter = await findOpenNewsletter({ slug: String(formData.get("newsletter") ?? ""), archiveEnabled: true });
	const contact = newsletter && await findSessionReader(newsletter);
	if (!contact) return { error: "Your session ended. Sign in again." };
	const result = await (await import("@/lib/supporter-badges")).saveSupporterBadge({ newsletter, contact, enabled: formData.get("supporterBadge") === "on" });
	return result.problem ? { error: result.problem } : { ok: true };
}
