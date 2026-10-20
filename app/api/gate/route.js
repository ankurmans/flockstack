import { NextResponse } from "next/server";
import { getArchiveIssue, getArchiveNewsletter } from "@/lib/archive-data";
import { renderArchiveBody } from "@/lib/archive-gate";
import { connectDb } from "@/lib/db";
import { getClientIp, isRateLimited } from "@/lib/rate-limit";
import { endReaderSession, findSessionReader } from "@/lib/reader-session";
import { listLiveRecommendations } from "@/lib/recommendations";
import { ARCHIVE_SLUG_PATTERN } from "@/lib/slug";

export const dynamic = "force-dynamic";

// In memory: it only reads, and a page that asks once per view isn't worth a write.
const PER_VISITOR = { name: "gate-ip", limit: 60, window: "10 m", store: "memory" };

function answer(body, status = 200) {
	return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

// The rest of a gated issue (lib/popup-rules.js), for a reader the website knows: the browser's session for this newsletter
// (lib/reader-session.js) has to be that of a subscriber who is still active. Anyone else gets nothing, and a paid issue's
// full text is never here: its page is a teaser for everyone.
export async function GET(request) {
	const { searchParams } = request.nextUrl;
	const slug = searchParams.get("n") ?? "";
	const post = searchParams.get("p") ?? "";
	if (!ARCHIVE_SLUG_PATTERN.test(post)) return answer({ ok: false }, 404);
	if (await isRateLimited({ ...PER_VISITOR, key: getClientIp(request.headers) })) return answer({ ok: false }, 429);

	await connectDb();
	const newsletter = await getArchiveNewsletter(slug);
	const issue = newsletter && (await getArchiveIssue(newsletter, post));
	if (!issue) return answer({ ok: false }, 404);
	const reader = await findSessionReader(newsletter);
	if (!reader) {
		// The marker said there was a session; it has expired or its subscriber left.
		await endReaderSession(newsletter);
		return answer({ ok: false }, 401);
	}
	const recommendations = await listLiveRecommendations(newsletter).catch(() => []);
	const { kind, html } = renderArchiveBody({ newsletter, issue, recommendations });
	if (kind === "paywall") return answer({ ok: false }, 403);
	return answer({ ok: true, kind, html });
}
