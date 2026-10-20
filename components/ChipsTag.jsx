import { cn } from "@/lib/utils";

// An issue's tags, or the newsletter's, each linking to its page. tags: { name, slug }. activeSlug: the one being read.
export default function ChipsTag({ tags, urls, activeSlug = "", className }) {
	if (tags.length === 0) return null;
	return (
		<ul aria-label="Tags" className={cn("flex flex-wrap gap-2", className)}>
			{tags.map(({ name, slug }) => (
				<li key={slug}>
					<a
						href={urls.tag(slug)}
						aria-current={slug === activeSlug ? "page" : undefined}
						className={cn(
							"inline-flex h-7 items-center rounded-full px-3 text-xs font-medium transition-colors duration-150",
							slug === activeSlug ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:text-foreground"
						)}
					>
						{name}
					</a>
				</li>
			))}
		</ul>
	);
}
