import "server-only";
import { getArchiveIssue, getArchiveNewsletter } from "@/lib/archive-data";
import { isGatedFor } from "@/lib/archive-gate";
import { connectDb } from "@/lib/db";
import { listLiveRecommendations } from "@/lib/recommendations";
import { findSessionReader } from "@/lib/reader-session";
import { ARCHIVE_SLUG_PATTERN } from "@/lib/slug";
import { isPaidContact } from "@/lib/tiers";
import { renderWebIssue } from "@/lib/web-issue";

// What a signed-in reader's browser gets from the website beyond the page everyone gets. The issue pages are cached for
// everybody and show the upgrade card where the paid part starts; the browser of a reader with a session asks here, and
// only a paid reader gets the rest. Free readers, anonymous visitors, a session for another newsletter, an expired one and a
// reader who left all get nothing: signedIn says whether the browser still has a reader, for its Account link. An issue the
// newsletter gates (lib/popup-rules.js) shows only its beginning to everyone else, and opens for any subscriber who is signed in.
export async function unlockIssueForReader({ slug, post }) {
	await connectDb();
	const newsletter = await getArchiveNewsletter(String(slug ?? ""));
	if (!newsletter || !ARCHIVE_SLUG_PATTERN.test(String(post ?? ""))) return { unlocked: false, signedIn: false };
	const reader = await findSessionReader(newsletter);
	if (!reader) return { unlocked: false, signedIn: false };
	const issue = await getArchiveIssue(newsletter, String(post));
	if (!issue) return { unlocked: false, signedIn: true };
	const isPaid = isPaidContact(reader);
	if (!isPaid && !(await isGatedFor(newsletter, issue))) return { unlocked: false, signedIn: true };
	const recommendations = await listLiveRecommendations(newsletter).catch(() => []);
	const body = renderWebIssue({ newsletter, issue, recommendations, isUnlocked: isPaid });
	return { unlocked: true, signedIn: true, kind: body.kind, html: body.html, ...(body.isPartial && { isPartial: true }) };
}
