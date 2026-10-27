import { hasAudienceBlocks } from "@/lib/audience-blocks";
import { readerIssueEntitlement } from "@/lib/metered-reading";
import "server-only";
import { getArchiveIssue, getArchiveNewsletter } from "@/lib/archive-data";
import { isGatedFor } from "@/lib/archive-gate";
import { connectDb } from "@/lib/db";
import { listLiveRecommendations } from "@/lib/recommendations";
import { findSessionReader } from "@/lib/reader-session";
import { ARCHIVE_SLUG_PATTERN } from "@/lib/slug";
import { isInPaidTiers, isPaidContact } from "@/lib/tiers";
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
	// A paid issue for a tier or higher opens for the readers of those tiers only (lib/tier-rules.js).
	const { paid: isPaid, canReadFull, meter } = await readerIssueEntitlement(newsletter, issue, reader);
	if (!canReadFull && !(await isGatedFor(newsletter, issue))) return { unlocked: false, signedIn: true, ...(meter && { meter }) };
	const recommendations = await listLiveRecommendations(newsletter).catch(() => []);
	const body = renderWebIssue({ newsletter, issue, recommendations, isUnlocked: canReadFull, reader, readerTier: isPaid ? "paid" : meter?.allowed ? "metered" : "free" });
	return { unlocked: true, signedIn: true, kind: body.kind, html: body.html, ...(meter?.allowed && !isPaid && { audioAllowed: false }), ...(body.isPartial && { isPartial: true }) };
}

// Who may hear an issue's audio file, by the same rules as reading the issue. Audio made for paid readers (an issue for paid
// subscribers only, or audio that was) goes to a paid reader whose tier can read the issue (isInPaidTiers). An issue the
// newsletter gates opens its audio for any subscriber who is signed in. Everything else is public. access is how a cache may
// keep the answer; status says why not (401: nobody is signed in, 403: signed in and not allowed).
export async function getAudioAccess({ newsletter, issue, file }) {
	if (issue.format === "rich" && hasAudienceBlocks(issue.html)) return { ok: false, status: 403 };
	await connectDb();
	if (file.scope === "paid" || issue.audience === "paid") {
		const reader = await findSessionReader(newsletter);
		if (reader && isPaidContact(reader) && isInPaidTiers(reader, issue.audienceTiers)) return { ok: true, access: "private" };
		return { ok: false, status: reader ? 403 : 401 };
	}
	if (await isGatedFor(newsletter, issue)) {
		return (await findSessionReader(newsletter)) ? { ok: true, access: "private" } : { ok: false, status: 401 };
	}
	return { ok: true, access: "public" };
}
