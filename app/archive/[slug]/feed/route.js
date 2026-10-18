import { buildFeed, getFeedEtag } from "@/lib/archive-feed";
import { getArchiveNewsletter, listFeedIssues } from "@/lib/archive-data";
import { listLiveRecommendations } from "@/lib/recommendations";

// Served as /feed.xml on the newsletter's own domain (see proxy.js). Readers poll often: a conditional request gets a
// 304 without the body, and a cache in front may keep the file for 15 minutes.
export async function GET(request, { params }) {
	const newsletter = await getArchiveNewsletter((await params).slug);
	if (!newsletter) return new Response("Not found", { status: 404 });

	const [issues, recommendations] = await Promise.all([listFeedIssues(newsletter), listLiveRecommendations(newsletter).catch(() => [])]);
	const { xml, lastModified } = buildFeed({ newsletter, issues, recommendations });
	const etag = getFeedEtag(xml);
	const headers = {
		"Content-Type": "application/rss+xml; charset=utf-8",
		"Cache-Control": "public, max-age=300, s-maxage=900, stale-while-revalidate=86400",
		ETag: etag,
		"X-Content-Type-Options": "nosniff",
		"Access-Control-Allow-Origin": "*",
		...(lastModified && { "Last-Modified": lastModified.toUTCString() }),
	};
	if (request.headers.get("if-none-match")?.split(",").some((value) => value.trim().replace(/^W\//, "") === etag)) {
		return new Response(null, { status: 304, headers });
	}
	return new Response(xml, { headers });
}
