import { getOpenArchiveNewsletter } from "@/lib/archive-data";
import { buildPodcastFeed } from "@/lib/audio-feed";
import { isAudioEnabled } from "@/lib/audio-config";
import { listPodcastEpisodes } from "@/lib/audio";

// Served as /podcast.xml on the newsletter's own domain (see proxy.js), once its owner turns the podcast on. Podcast apps
// poll often: a conditional request gets a 304 without the body, and a cache in front may keep the file for 15 minutes.
// Only issues for everyone with audio are in it.
export async function GET(request, { params }) {
	const newsletter = await getOpenArchiveNewsletter((await params).slug);
	if (!newsletter?.audio?.podcast?.enabled || !isAudioEnabled()) return new Response("Not found", { status: 404 });

	const { xml, lastModified, etag } = buildPodcastFeed({ newsletter, episodes: await listPodcastEpisodes(newsletter) });
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
