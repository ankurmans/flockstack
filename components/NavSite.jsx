import { cn } from "@/lib/utils";

// The website's navigation bar: links the writer chose (lib/site-navigation.js getNavLinks).
export default function NavSite({ links, className, linkClassName }) {
	if (links.length === 0) return null;
	return (
		<nav aria-label="Pages" className={className}>
			<ul className="flex items-center gap-5 overflow-x-auto whitespace-nowrap">
				{links.map(({ id, label, href, isExternal }) => (
					<li key={id}>
						<a
							href={href}
							{...(isExternal && { rel: "noopener noreferrer", target: "_blank" })}
							className={cn("text-sm font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground", linkClassName)}
						>
							{label}
						</a>
					</li>
				))}
			</ul>
		</nav>
	);
}
