import { getArchiveAuthors } from "@/lib/archive-author";
import { getArchiveNewsletter, getShopPayments, listArchiveIssues, listIssueTags, listPublishedPages, listShopProducts } from "@/lib/archive-data";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { getIssueModified } from "@/lib/archive-issues";

export const revalidate = 3600;

function escapeXml(value) {
	return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function entry(loc, date) {
	const lastmod = date ? `<lastmod>${new Date(date).toISOString()}</lastmod>` : "";
	return `<url><loc>${escapeXml(loc)}</loc>${lastmod}</url>`;
}

function latest(dates) {
	return dates.filter(Boolean).map((date) => new Date(date)).sort((a, b) => b - a)[0] ?? null;
}

// Every page has the moment it last changed: an issue's is its date, or the owner's later change to its search settings;
// the home and author pages change with the newest issue and the shop with its newest product. An issue marked noindex
// is left out, as search engines are asked to.
export async function GET(_request, { params }) {
	const newsletter = await getArchiveNewsletter((await params).slug);
	if (!newsletter) return new Response("Not found", { status: 404 });

	const urls = getArchiveUrls(newsletter);
	const [listed, products, payments, pages, tags] = await Promise.all([
		listArchiveIssues(newsletter),
		listShopProducts(newsletter),
		getShopPayments(newsletter),
		listPublishedPages(newsletter),
		listIssueTags(newsletter),
	]);
	const issues = listed.filter((issue) => !issue.seo?.noindex);
	const latestDate = latest(issues.map(getIssueModified));
	const shopped = payments.ready ? products : [];
	const xml = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
		entry(urls.siteIndex, latestDate),
		...getArchiveAuthors(newsletter).map((author) => entry(urls.absoluteAuthor(author.slug), latestDate)),
		entry(urls.absoluteIssues, latestDate),
		...issues.map((issue) => entry(urls.absolutePost(issue.archiveSlug), getIssueModified(issue))),
		...pages.map((page) => entry(urls.absolutePost(page.slug), page.updatedAt)),
		...tags.map((tag) => entry(urls.absoluteTag(tag.slug), latestDate)),
		...(shopped.length > 0 ? [entry(urls.absoluteShop, latest(shopped.map(({ updatedAt }) => updatedAt))), ...shopped.map((product) => entry(urls.absoluteProduct(product.slug), product.updatedAt))] : []),
		"</urlset>",
	].join("\n");

	return new Response(xml, {
		headers: {
			"Content-Type": "application/xml; charset=utf-8",
			"Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
		},
	});
}
