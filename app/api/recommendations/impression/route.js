import { isLikelyBot } from "@/lib/bots";
import { getClientIp, isRateLimited } from "@/lib/rate-limit";
import { countImpressions } from "@/lib/recommendations";

// In memory, like the issue views: counting in the database would double what each beacon costs. A visitor's browser sends
// one a day per newsletter and place; a script sending more stops being counted.
const PER_VISITOR = { name: "recommendation-impressions", limit: 30, window: "10 m", store: "memory" };
const PER_NEWSLETTER = { name: "recommendation-impressions-newsletter", limit: 10, window: "1 h", store: "memory" };

function noContent() {
	return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

// Archive pages and the signup step send a beacon naming the newsletters they showed. Nothing about the reader is stored:
// the address is only a key for the limit, in memory.
export async function POST(request) {
	const userAgent = request.headers.get("user-agent") ?? "";
	const { newsletter, shown } = await request.json().catch(() => ({}));
	if (typeof newsletter !== "string" || isLikelyBot(userAgent)) return noContent();
	const ip = getClientIp(request.headers);
	if (await isRateLimited({ ...PER_VISITOR, key: ip })) return noContent();
	if (await isRateLimited({ ...PER_NEWSLETTER, key: `${newsletter.slice(0, 40)}:${ip}` })) return noContent();

	await countImpressions({ slug: newsletter, shown }).catch((error) => console.error("[recommendations] Impression not counted:", error.message));
	return noContent();
}
