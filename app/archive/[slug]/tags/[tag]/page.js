import { notFound } from "next/navigation";
import ChipsTag from "@/components/ChipsTag";
import ListIssues from "@/components/ListIssues";
import PaginationIssues from "@/components/PaginationIssues";
import { getArchiveNewsletter, listIssueTags, listIssuesPage } from "@/lib/archive-data";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { getListSeo } from "@/lib/archive-seo";
import { getBrand } from "@/lib/brand";
import { readPageNumber } from "@/lib/page-number";

const TAG_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,59}$/;

// A tag's page: the issues that carry it, a page at a time. A tag nobody uses is not found.
export const dynamic = "force-dynamic";

async function getTagPage(params, searchParams) {
	const { slug, tag } = await params;
	const newsletter = await getArchiveNewsletter(slug);
	if (!newsletter || !TAG_SLUG_PATTERN.test(tag)) return null;
	const [list, tags] = await Promise.all([
		listIssuesPage(newsletter, { page: readPageNumber((await searchParams).page), tagSlug: tag }),
		listIssueTags(newsletter),
	]);
	const first = list.issues[0];
	const name = first?.tags?.[first.tagSlugs?.indexOf(tag)] ?? tag;
	return list.total > 0 ? { newsletter, list, tags, tag: { slug: tag, name } } : null;
}

export async function generateMetadata({ params, searchParams }) {
	const page = await getTagPage(params, searchParams);
	if (!page) return {};
	const { newsletter, list, tag } = page;
	const urls = getArchiveUrls(newsletter);
	return getListSeo(newsletter, {
		title: `Issues tagged ${tag.name}`,
		url: list.page > 1 ? `${urls.absoluteTag(tag.slug)}?page=${list.page}` : urls.absoluteTag(tag.slug),
		description: `Issues of ${newsletter.name} about ${tag.name}.`,
		isIndexed: list.page === 1,
	});
}

export default async function TagPage({ params, searchParams }) {
	const page = await getTagPage(params, searchParams);
	if (!page) notFound();
	const { newsletter, list, tags, tag } = page;
	const urls = getArchiveUrls(newsletter);
	const hrefFor = (target) => (target > 1 ? `${urls.tag(tag.slug)}?page=${target}` : urls.tag(tag.slug));

	return (
		<div className="mx-auto max-w-5xl px-5 pt-12 pb-24 sm:pt-16">
			<p className="site-label text-sm text-muted-foreground">
				<a href={urls.issues} className="transition-colors duration-150 hover:text-foreground">
					All issues
				</a>{" "}
				/ Tag
			</p>
			<h1 className="site-title mt-2 text-3xl font-semibold tracking-tight animate-enter sm:text-4xl">{tag.name}</h1>
			<p className="mt-2 text-sm text-muted-foreground tabular-nums">
				{list.total} {list.total === 1 ? "issue" : "issues"}
			</p>
			<ChipsTag tags={tags.slice(0, 20)} urls={urls} activeSlug={tag.slug} className="mt-6" />
			<div className="mt-10">
				<ListIssues issues={list.issues} newsletter={newsletter} urls={urls} theme={getBrand(newsletter).theme} />
			</div>
			<PaginationIssues page={list.page} pages={list.pages} hrefFor={hrefFor} />
		</div>
	);
}
