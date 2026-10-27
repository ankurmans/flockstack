import { getReaderText } from "@/lib/reader-languages";
import { Search } from "lucide-react";
import { MAX_SEARCH_LENGTH } from "@/lib/archive-data";

// Search by title: a plain GET form to the same page, so it works without a script.
export default function FormSearchIssues({ language = "en", action, defaultValue = "" }) {
	const t = getReaderText(language);
	return (
		<form action={action} method="get" role="search" className="flex w-full max-w-sm items-center gap-2">
			<label htmlFor="issue-search" className="sr-only">
				{t("Search issues by title")}
			</label>
			<span className="relative flex-1">
				<Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
				<input
					id="issue-search"
					type="search"
					name="q"
					defaultValue={defaultValue}
					maxLength={MAX_SEARCH_LENGTH}
					placeholder={t("Search by title")}
					className="h-10 w-full rounded-xl bg-background pr-3 pl-9 text-base shadow-border outline-none transition-shadow duration-150 placeholder:text-muted-foreground focus-visible:shadow-border-hover focus-visible:ring-3 focus-visible:ring-ring/25"
				/>
			</span>
			<button type="submit" className="h-10 rounded-xl px-4 text-sm font-medium shadow-border transition-shadow duration-150 hover:shadow-border-hover">
				{t("Search")}
			</button>
		</form>
	);
}
