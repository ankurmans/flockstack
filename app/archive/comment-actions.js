"use server";

import { headers } from "next/headers";
import { after } from "next/server";
import { connectDb } from "@/lib/db";
import { findOpenNewsletter } from "@/lib/public-newsletters";
import { getClientIp, isRateLimited } from "@/lib/rate-limit";
import { endReaderSession, limitKey, sendSignInEmail } from "@/lib/reader-session";
import { ARCHIVE_SLUG_PATTERN } from "@/lib/slug";
import { normalizeEmail } from "@/lib/validation";

// One request is one email: a flood from a network, or at one address, stops early. Both count whether or not the
// address is subscribed, so a limit never tells the two apart.
const SIGNIN_PER_IP = { name: "reader-link-ip", limit: 5, window: "10 m" };
const SIGNIN_PER_ADDRESS = { name: "reader-link-address", limit: 3, window: "1 h" };

const SIGNIN_SENT_MESSAGE = "If this address is subscribed, a sign-in link is on its way. It works once, for 30 minutes.";

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
