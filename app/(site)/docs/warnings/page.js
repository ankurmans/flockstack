import HeaderDocs from "@/components/HeaderDocs";
import { getDocsPageMetadata } from "@/lib/docs/llms";
import { getWarningsGuide } from "@/lib/docs/warnings";

export const metadata = getDocsPageMetadata("/docs/warnings");

export default function WarningsPage() {
	return (
		<>
			<HeaderDocs kicker="Guides" title="Warnings and blocks">
				FlockStack watches bounces and spam complaints, because every customer shares the same sending reputation. You hear about a
				problem before anything stops, except for spam traps.
			</HeaderDocs>

			<div className="grid max-w-3xl gap-12">
				{getWarningsGuide().map(({ title, paragraphs }, index) => (
					<section key={title} style={{ "--stagger": index + 1 }} className="animate-enter">
						<h2 className="text-xl font-semibold tracking-tight">{title}</h2>
						<div className="mt-4 grid gap-4">
							{paragraphs.map((paragraph) => (
								<p key={paragraph} className="text-[15px] leading-7 text-pretty text-foreground/80">
									{paragraph}
								</p>
							))}
						</div>
					</section>
				))}
			</div>
		</>
	);
}
