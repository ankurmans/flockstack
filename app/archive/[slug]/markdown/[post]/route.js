import { getArchiveIssue, getArchiveNewsletter } from "@/lib/archive-data";
import { getGatePreview, isGatedFor } from "@/lib/archive-gate";
import { getArchiveMarkdown } from "@/lib/archive-markdown";

export const revalidate = 3600;
export async function GET(_request, { params }) {
	const { slug, post } = await params;
	const newsletter = await getArchiveNewsletter(slug);
	const issue = newsletter && await getArchiveIssue(newsletter, post);
	if (!issue) return new Response("Not found", { status: 404 });
	const gated = await isGatedFor(newsletter, issue);
	return new Response(getArchiveMarkdown(issue, { gatedHtml: gated ? getGatePreview(newsletter, issue) : null }), {
		headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400", "X-Robots-Tag": "noindex", "X-Content-Type-Options": "nosniff" },
	});
}
