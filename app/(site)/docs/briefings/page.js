import BlockCode from "@/components/BlockCode";
import HeaderDocs from "@/components/HeaderDocs";
import { BRIEFINGS_GUIDE, BRIEFINGS_INTRO } from "@/lib/docs/briefings-guide";
import { getDocsPageMetadata } from "@/lib/docs/pages";

export const metadata = getDocsPageMetadata("/docs/briefings");

// `name` in a paragraph is code, and [label](/path) a link.
function Text({ children }) {
	return children.split(/(`[^`]+`|\[[^\]]+\]\([^)]+\))/).map((part, index) => {
		if (part.startsWith("`")) {
			return (
				<code key={index} className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[13px] text-foreground">
					{part.slice(1, -1)}
				</code>
			);
		}
		const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
		return link ? (
			<a key={index} href={link[2]} className="text-link hover:underline">
				{link[1]}
			</a>
		) : (
			part
		);
	});
}

function Paragraphs({ items }) {
	return items.map((paragraph) => (
		<p key={paragraph} className="text-[15px] leading-7 text-pretty text-foreground/80">
			<Text>{paragraph}</Text>
		</p>
	));
}

export default function BriefingsDocsPage() {
	return (
		<>
			<HeaderDocs kicker="Briefings" title="Run a newsletter with an agent">
				{BRIEFINGS_INTRO}
			</HeaderDocs>

			<div className="grid max-w-3xl gap-12">
				{BRIEFINGS_GUIDE.map(({ title, paragraphs = [], list = [], after = [], code }, index) => (
					<section key={title} style={{ "--stagger": index + 1 }} className="animate-enter">
						<h2 className="text-xl font-semibold tracking-tight">{title}</h2>
						<div className="mt-4 grid gap-4">
							<Paragraphs items={paragraphs} />
							{list.length > 0 && (
								<ul className="list-disc pl-5 text-[15px] leading-7 text-pretty text-foreground/80">
									{list.map((item) => (
										<li key={item}>
											<Text>{item}</Text>
										</li>
									))}
								</ul>
							)}
							<Paragraphs items={after} />
							{code && <BlockCode title={code.title} code={JSON.stringify(code.value, null, 2)} />}
						</div>
					</section>
				))}
			</div>
		</>
	);
}
