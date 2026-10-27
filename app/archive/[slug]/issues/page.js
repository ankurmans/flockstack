import { notFound } from "next/navigation";
import ChipsTag from "@/components/ChipsTag";
import FormSearchIssues from "@/components/FormSearchIssues";
import ListIssues from "@/components/ListIssues";
import PaginationIssues from "@/components/PaginationIssues";
import { getArchiveNewsletter, listIssueTags, listIssuesPage, MAX_SEARCH_LENGTH } from "@/lib/archive-data";
import { getArchiveUrls } from "@/lib/archive-hosts";
import { getListSeo } from "@/lib/archive-seo";
import { getBrand } from "@/lib/brand";
import { readPageNumber } from "@/lib/page-number";

// Every issue, a page at a time, with a search by title and the newsletter's tags. It reads the address's ?page and ?q,
// so it is built per request.
export const dynamic = "force-dynamic";

function readSearch(value) {
	return typeof value === "string" ? value.trim().slice(0, MAX_SEARCH_LENGTH) : "";
}

export async function generateMetadata({ params, searchParams }) {
	const newsletter = await getArchiveNewsletter((await params).slug);
	if (!newsletter) return {};
	const { q, page } = await searchParams;
	const pageNumber = readPageNumber(page);
	const urls = getArchiveUrls(newsletter);
	return getListSeo(newsletter, {
		title: "All issues",
		url: pageNumber > 1 ? `${urls.absoluteIssues}?page=${pageNumber}` : urls.absoluteIssues,
		description: `Every issue of ${newsletter.name}.`,
		isIndexed: !readSearch(q) && pageNumber === 1,
	});
}

export default async function IssuesPage({ params, searchParams }) {
	const newsletter = await getArchiveNewsletter((await params).slug);
	if (!newsletter) notFound();
	const { q, page } = await searchParams;
	const search = readSearch(q);
	const [list, tags] = await Promise.all([listIssuesPage(newsletter, { page: readPageNumber(page), search }), listIssueTags(newsletter)]);
	const urls = getArchiveUrls(newsletter);
	const hrefFor = (target) => {
		const query = new URLSearchParams({ ...(search && { q: search }), ...(target > 1 && { page: String(target) }) }).toString();
		return query ? `${urls.issues}?${query}` : urls.issues;
	};

	return (
		<div className="mx-auto max-w-5xl px-5 pt-12 pb-24 sm:pt-16">
			<h1 className="site-title text-3xl font-semibold tracking-tight animate-enter sm:text-4xl">All issues</h1>
			<div className="mt-6 flex flex-col gap-4">
				<FormSearchIssues language={newsletter.language ?? "en"} action={urls.issues} defaultValue={search} />
				<ChipsTag tags={tags.slice(0, 20)} urls={urls} />
			</div>
			<p className="mt-8 text-sm text-muted-foreground tabular-nums" aria-live="polite">
				{search ? `${list.total} ${list.total === 1 ? "issue" : "issues"} with “${search}” in the title` : `${list.total} ${list.total === 1 ? "issue" : "issues"}`}
			</p>
			<div className="mt-6">
				{list.issues.length > 0 ? (
					<ListIssues issues={list.issues} newsletter={newsletter} urls={urls} theme={getBrand(newsletter).theme} />
				) : (
					<p className="text-muted-foreground">{search ? "No issue has those words in its title." : "No issues yet."}</p>
				)}
			</div>
			<PaginationIssues language={newsletter.language ?? "en"} page={list.page} pages={list.pages} hrefFor={hrefFor} />
		</div>
	);
}
