"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { connectDb } from "@/lib/db";
import { getClientIp, isRateLimited } from "@/lib/rate-limit";
import { SIGNIN_DESTINATIONS } from "@/lib/reader-links";
import { redeemSignInLink } from "@/lib/reader-session";
import { ARCHIVE_SLUG_PATTERN } from "@/lib/slug";

const PER_IP = { name: "reader-signin-ip", limit: 20, window: "10 m" };

// The button on the sign-in page: it uses the link up and starts the reader's session. Opening the page alone changes
// nothing, so a mail scanner that follows the link doesn't spend it.
export async function continueSignIn(formData) {
	const token = String(formData.get("token") ?? "");
	const issueSlug = String(formData.get("p") ?? "");
	const next = SIGNIN_DESTINATIONS.includes(formData.get("next")) ? formData.get("next") : "";
	if (await isRateLimited({ ...PER_IP, key: getClientIp(await headers()) })) redirect(backTo(token, issueSlug, next));
	await connectDb();
	const { newsletter, contact } = await redeemSignInLink(token);
	if (!contact) redirect(backTo(token, issueSlug, next));
	const urls = getArchiveUrls(newsletter);
	if (next === "account") redirect(urls.absoluteAccount);
	redirect(`${ARCHIVE_SLUG_PATTERN.test(issueSlug) ? urls.absolutePost(issueSlug) : urls.siteIndex}#comments`);
}

// The page again, which says what is wrong with the link.
function backTo(token, issueSlug, next) {
	const query = new URLSearchParams({ token, ...(ARCHIVE_SLUG_PATTERN.test(issueSlug) && { p: issueSlug }), ...(next && { next }) });
	return `/reader/signin?${query}`;
}
