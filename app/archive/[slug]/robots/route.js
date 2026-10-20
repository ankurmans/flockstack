import { getArchiveNewsletter } from "@/lib/archive-data";
import { getArchiveUrls } from "@/lib/archive-hosts";

// Served as /robots.txt on the newsletter's own domain (see proxy.js).
export async function GET(_request, { params }) {
	const newsletter = await getArchiveNewsletter((await params).slug);
	if (!newsletter) return new Response("Not found", { status: 404 });

	return new Response(`User-agent: *\nAllow: /\n\nSitemap: ${getArchiveUrls(newsletter).sitemap}\n`, {
		headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, s-maxage=86400" },
	});
}
