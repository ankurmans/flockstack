import { getReaderText } from "@/lib/reader-languages";
// Previous and next links for a paged list. hrefFor(page): the address of a page. Plain links, so it needs no script.
export default function PaginationIssues({ language = "en", page, pages, hrefFor }) {
	const t = getReaderText(language);
	if (pages <= 1) return null;
	const link = "inline-flex h-9 items-center rounded-lg px-3 text-sm font-medium shadow-border transition-shadow duration-150 hover:shadow-border-hover";
	return (
		<nav aria-label={t("Pages of issues")} className="mt-12 flex items-center justify-between gap-4">
			{page > 1 ? (
				<a href={hrefFor(page - 1)} rel="prev" className={link}>
					{t("← Newer")}
				</a>
			) : (
				<span />
			)}
			<p className="text-sm text-muted-foreground tabular-nums">
				{t("Page {page} of {pages}", { page, pages })}
			</p>
			{page < pages ? (
				<a href={hrefFor(page + 1)} rel="next" className={link}>
					{t("Older →")}
				</a>
			) : (
				<span />
			)}
		</nav>
	);
}
