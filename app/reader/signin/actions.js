"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { connectDb } from "@/lib/db";
import { getClientIp, isRateLimited } from "@/lib/rate-limit";
import { redeemSignInLink } from "@/lib/reader-session";
import { ARCHIVE_SLUG_PATTERN } from "@/lib/slug";

const PER_IP = { name: "reader-signin-ip", limit: 20, window: "10 m" };

// The button on the sign-in page: it uses the link up and starts the reader's session. Opening the page alone changes
// nothing, so a mail scanner that follows the link doesn't spend it.
export async function continueSignIn(formData) {
	const token = String(formData.get("token") ?? "");
	const issueSlug = String(formData.get("p") ?? "");
	// A link for a gated issue (lib/popup-rules.js) opens the issue itself, not its comments.
	const isGate = formData.get("g") === "1";
	if (await isRateLimited({ ...PER_IP, key: getClientIp(await headers()) })) redirect(backTo(token, issueSlug, isGate));
	await connectDb();
	const { newsletter, contact } = await redeemSignInLink(token);
	if (!contact) redirect(backTo(token, issueSlug, isGate));
	const urls = getArchiveUrls(newsletter);
	redirect(`${ARCHIVE_SLUG_PATTERN.test(issueSlug) ? urls.absolutePost(issueSlug) : urls.siteIndex}${isGate ? "" : "#comments"}`);
}

// The page again, which says what is wrong with the link.
function backTo(token, issueSlug, isGate) {
	const query = new URLSearchParams({ token, ...(ARCHIVE_SLUG_PATTERN.test(issueSlug) && { p: issueSlug }), ...(isGate && { g: "1" }) });
	return `/reader/signin?${query}`;
}
