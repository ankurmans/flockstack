import AvatarNewsletter from "@/components/AvatarNewsletter";
import TrackRecommendations from "@/components/TrackRecommendations";
import { cn } from "@/lib/utils";

// The newsletters this one recommends, on its archive home and its issue pages. Each card leads to the other newsletter's own
// signup page; nothing is subscribed from here.
export default function ListRecommendations({ newsletterSlug, items, className }) {
	if (!items?.length) return null;

	return (
		<section aria-labelledby="recommended-newsletters" className={cn("mx-auto max-w-5xl px-5", className)}>
			<h2 id="recommended-newsletters" className="mb-4 text-sm font-medium text-muted-foreground">
				Recommended newsletters
			</h2>
			<ul className="grid gap-3 sm:grid-cols-2">
				{items.map((item) => (
					<li key={item.slug}>
						<a
							href={item.url}
							rel="noopener"
							className="flex h-full gap-3.5 rounded-xl bg-card p-4 shadow-border transition-shadow duration-150 hover:shadow-border-hover"
						>
							<AvatarNewsletter newsletter={item} size={40} />
							<span className="min-w-0">
								<span className="block font-medium">{item.name}</span>
								<span className="mt-0.5 block text-sm text-pretty text-muted-foreground">{item.pitch}</span>
							</span>
						</a>
					</li>
				))}
			</ul>
			<TrackRecommendations newsletterSlug={newsletterSlug} shown={items.map(({ slug }) => slug)} surface="archive" />
		</section>
	);
}
