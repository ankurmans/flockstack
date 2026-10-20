"use server";

import { headers } from "next/headers";
import { after } from "next/server";
import { connectDb } from "@/lib/db";
import { findOpenNewsletter } from "@/lib/public-newsletters";
import { getClientIp, isRateLimited } from "@/lib/rate-limit";
import { limitKey } from "@/lib/reader-links";
import { SIGNIN_PER_ADDRESS, SIGNIN_PER_IP, SIGNIN_SENT_MESSAGE } from "@/lib/reader-limits";
import { sendSignInEmail } from "@/lib/reader-session";
import { ARCHIVE_SLUG_PATTERN } from "@/lib/slug";
import { normalizeEmail } from "@/lib/validation";

// The reader sign-in's own limits and answer (lib/reader-limits.js), shared with the comments' and the Sign in page's: one request
// is one email, the limits count whether or not the address is subscribed, and the answer is the same for every address.

// "Already subscribed?" on a gated issue: a one-time link by email that signs the reader in to the website and opens the issue.
export async function requestGateSignIn(_state, formData) {
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
			if (newsletter && ARCHIVE_SLUG_PATTERN.test(issueSlug)) await sendSignInEmail({ newsletter, email, issueSlug, isGate: true });
		} catch (error) {
			console.error("[gate] Sign-in email failed:", error.message);
		}
	});
	return { ok: true, message: SIGNIN_SENT_MESSAGE };
}
