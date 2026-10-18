import HeaderDocs from "@/components/HeaderDocs";
import LinkInline from "@/components/LinkInline";
import { EFFECTIVE_DATE, getPublishedLegalPages } from "@/lib/legal";

// The legal pages' column, their header and the links between the three.
export default function LayoutLegal({ title, intro, current, children }) {
	return (
		<main className="mx-auto max-w-3xl px-4 py-12 sm:px-6 sm:py-16">
			<HeaderDocs kicker="Legal" title={title}>
				{intro}
			</HeaderDocs>
			<p className="-mt-6 mb-10 text-sm text-muted-foreground">Effective {EFFECTIVE_DATE}</p>
			{children}
			<nav aria-label="Legal" className="mt-16 border-t border-border/60 pt-6">
				<p className="mb-3 font-mono text-[11px] tracking-wider text-muted-foreground uppercase">Legal</p>
				<ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
					{getPublishedLegalPages().map(({ href, title: label }) => (
						<li key={href}>
							{href === current ? (
								<span aria-current="page" className="text-muted-foreground">
									{label}
								</span>
							) : (
								<LinkInline href={href}>{label}</LinkInline>
							)}
						</li>
					))}
				</ul>
			</nav>
		</main>
	);
}
