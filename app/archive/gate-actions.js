"use server";

import { headers } from "next/headers";
import { after } from "next/server";
import { connectDb } from "@/lib/db";
import { findOpenNewsletter } from "@/lib/public-newsletters";
import { getClientIp, isRateLimited } from "@/lib/rate-limit";
import { limitKey } from "@/lib/reader-links";
import { sendSignInEmail } from "@/lib/reader-session";
import { ARCHIVE_SLUG_PATTERN } from "@/lib/slug";
import { normalizeEmail } from "@/lib/validation";

// Like the comment sign-in (app/archive/comment-actions.js): one request is one email, the limits count whether or not the
// address is subscribed, and the answer is the same for every address.
const PER_IP = { name: "gate-link-ip", limit: 5, window: "10 m" };
const PER_ADDRESS = { name: "gate-link-address", limit: 3, window: "1 h" };
const SENT_MESSAGE = "If this address is subscribed, a link to read the issue is on its way. It works once, for 30 minutes.";

// "Already subscribed?" on a gated issue: a one-time link by email that signs the reader in to the website and opens the issue.
export async function requestGateSignIn(_state, formData) {
	// People never see this field; bots fill in every input they find.
	if (formData.get("website")) return { ok: true, message: SENT_MESSAGE };

	const email = normalizeEmail(formData.get("email"));
	if (!email) return { error: "Enter a valid email" };
	const slug = String(formData.get("newsletter") ?? "");
	const issueSlug = String(formData.get("p") ?? "");
	if (await isRateLimited({ ...PER_IP, key: getClientIp(await headers()) })) {
		return { error: "Too many requests from your network. Try again in a few minutes." };
	}
	if (await isRateLimited({ ...PER_ADDRESS, key: `${slug}:${limitKey(email)}` })) {
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
	return { ok: true, message: SENT_MESSAGE };
}
