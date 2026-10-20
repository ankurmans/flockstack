import { isLikelyBot } from "@/lib/bots";
import { connectDb } from "@/lib/db";
import { getClientIp, isRateLimited } from "@/lib/rate-limit";
import { ARCHIVE_SLUG_PATTERN } from "@/lib/slug";
import { VISIT_KINDS, VISIT_PER_VISITOR, countVisit, findVisitedNewsletter, getCountry, isOptedOut } from "@/lib/web-analytics";

const NEWSLETTER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

function noContent() {
	return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

// A newsletter's website says a page was opened (components/TrackVisit.jsx). Nothing comes back, and nothing is counted for a
// visitor whose browser says Do Not Track or Global Privacy Control, for a crawler, or for one that sends too many.
export async function POST(request) {
	if (isOptedOut(request.headers)) return noContent();
	const userAgent = request.headers.get("user-agent") ?? "";
	if (isLikelyBot(userAgent)) return noContent();
	const ip = getClientIp(request.headers);
	if (await isRateLimited({ ...VISIT_PER_VISITOR, key: ip })) return noContent();

	const body = await request.json().catch(() => null);
	const slug = String(body?.n ?? "");
	if (!NEWSLETTER_PATTERN.test(slug) || !VISIT_KINDS.includes(body?.kind)) return noContent();
	try {
		await connectDb();
		const newsletter = await findVisitedNewsletter(slug);
		if (!newsletter) return noContent();
		const post = ARCHIVE_SLUG_PATTERN.test(String(body.post ?? "")) ? String(body.post) : "";
		await countVisit({ newsletter, kind: body.kind, post, referrer: typeof body.ref === "string" ? body.ref : "", country: getCountry(request.headers), ip, userAgent });
	} catch (error) {
		console.error("[visits] A visit wasn't counted:", error.message);
	}
	return noContent();
}
