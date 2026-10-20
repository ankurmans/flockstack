import Link from "next/link";
import AvatarNewsletter from "@/components/AvatarNewsletter";
import { Button } from "@/components/ui/button";
import { APP_NAME, getAppUrl } from "@/lib/config";
import { searchListedNewsletters } from "@/lib/recommendations";
import { REGION_RULE } from "@/lib/recommendation-rules";
import { getPageMetadata } from "@/lib/site";

const PAGE_SIZE = 12;
const TITLE = "Newsletters that take recommendations";
const DESCRIPTION = `Find ${APP_NAME} newsletters that welcome recommendations from other newsletters, and recommend the ones your readers will like. Free, with no paid placement.`;

// A search is never a page of its own for search engines; the directory itself is. It lists this server's newsletters
// only, so it stays on this server's address even where the other shared pages are indexed at another's.
export async function generateMetadata({ searchParams }) {
	const { q, page } = await searchParams;
	return {
		metadataBase: new URL(getAppUrl()),
		...getPageMetadata({ title: TITLE, description: DESCRIPTION, path: "/recommendations" }),
		...((q || page) && { robots: { index: false, follow: true } }),
	};
}

function readPage(value) {
	const page = Number.parseInt(String(value ?? ""), 10);
	return Number.isInteger(page) && page >= 1 && page <= 100 ? page : 1;
}

function pageHref(query, page) {
	const params = new URLSearchParams();
	if (query) params.set("q", query);
	if (page > 1) params.set("page", String(page));
	const text = params.toString();
	return text ? `/recommendations?${text}` : "/recommendations";
}

// The directory: newsletters that listed themselves and take recommendations, by name, with a range of subscribers and a
// link to their website. Nothing about their readers, and no exact numbers.
export default async function RecommendationsDirectoryPage({ searchParams }) {
	const params = await searchParams;
	const query = String(params.q ?? "").trim().slice(0, 100);
	const page = readPage(params.page);
	const { newsletters, hasMore } = await searchListedNewsletters({ query, page, pageSize: PAGE_SIZE });

	return (
		<main className="mx-auto max-w-(--site-width) px-4 py-10 sm:px-6 lg:px-8">
			<header className="mb-8 max-w-2xl animate-enter">
				<p className="mb-3 font-mono text-[11px] tracking-wider text-muted-foreground uppercase">Directory</p>
				<h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{TITLE}</h1>
				<p className="mt-4 text-[17px] leading-8 text-pretty text-muted-foreground">
					Newsletters on {APP_NAME} that chose to be listed. Creators recommend each other for free: no paid placement, no cut of anyone&apos;s
					revenue. A reader&apos;s email only ever goes to a newsletter they sign up to themselves.
				</p>
			</header>

			<form action="/recommendations" method="get" role="search" className="mb-8 flex max-w-md items-center gap-2">
				<input
					type="search"
					name="q"
					defaultValue={query}
					maxLength={100}
					placeholder="Search by name or topic"
					aria-label="Search newsletters"
					className="h-10 min-w-0 flex-1 rounded-xl bg-background px-3.5 text-base shadow-border outline-none transition-shadow duration-150 placeholder:text-muted-foreground focus-visible:shadow-border-hover focus-visible:ring-3 focus-visible:ring-ring/25"
				/>
				<Button type="submit" size="lg">
					Search
				</Button>
			</form>

			{newsletters.length === 0 ? (
				<p className="text-muted-foreground">
					{query ? `No listed newsletter matches "${query}".` : "No newsletter is listed yet."} Creators list theirs from the Recommendations page of
					their dashboard.
				</p>
			) : (
				<ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
					{newsletters.map((item) => (
						<li key={item.slug} className="flex flex-col gap-3 rounded-xl bg-card p-4 shadow-border">
							<div className="flex items-center gap-3">
								<AvatarNewsletter newsletter={item} size={40} />
								<div className="min-w-0">
									<h2 className="truncate font-medium">{item.name}</h2>
									<p className="text-xs text-muted-foreground">{item.subscriberRange} subscribers</p>
								</div>
							</div>
							{item.description && <p className="text-sm text-pretty text-muted-foreground">{item.description}</p>}
							<a
								href={item.url}
								rel="noopener"
								className="mt-auto text-sm font-medium underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground"
							>
								Visit the website
							</a>
						</li>
					))}
				</ul>
			)}

			{(page > 1 || hasMore) && (
				<nav aria-label="Pages" className="mt-8 flex items-center gap-4 text-sm">
					{page > 1 && (
						<Link href={pageHref(query, page - 1)} className="text-muted-foreground hover:text-foreground">
							← Previous
						</Link>
					)}
					{hasMore && (
						<Link href={pageHref(query, page + 1)} className="text-muted-foreground hover:text-foreground">
							Next →
						</Link>
					)}
				</nav>
			)}

			<p className="mt-12 max-w-2xl text-xs text-pretty text-muted-foreground">
				{REGION_RULE} Want yours here?{" "}
				<Link href="/docs/recommendations" className="underline underline-offset-4 hover:text-foreground">
					How recommendations work
				</Link>
				.
			</p>
		</main>
	);
}
