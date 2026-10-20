import { getArchiveAuthor } from "@/lib/archive-author";
import { getArchiveNewsletter, listArchiveIssues } from "@/lib/archive-data";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { getLlmsTxt } from "@/lib/archive-llms";

export const revalidate = 3600;

// Served as /llms.txt on the newsletter's own domain (see proxy.js): the newsletter and its latest free issues in the plain
// format AI assistants read (llmstxt.org).
export async function GET(_request, { params }) {
	const newsletter = await getArchiveNewsletter((await params).slug);
	if (!newsletter) return new Response("Not found", { status: 404 });

	const issues = await listArchiveIssues(newsletter, { limit: 100 });
	return new Response(getLlmsTxt({ newsletter, issues, urls: getArchiveUrls(newsletter), author: getArchiveAuthor(newsletter) }), {
		headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
	});
}
