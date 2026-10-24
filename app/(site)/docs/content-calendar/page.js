import BlockCode from "@/components/BlockCode";
import HeaderDocs from "@/components/HeaderDocs";
import { CONTENT_CALENDAR_GUIDE } from "@/lib/docs/content-calendar";
import { getDocsPageMetadata } from "@/lib/docs/pages";

export const metadata = getDocsPageMetadata("/docs/content-calendar");

// `name` in a paragraph is code.
function Text({ children }) {
	return children.split(/(`[^`]+`)/).map((part, index) =>
		part.startsWith("`") ? (
			<code key={index} className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[13px] text-foreground">
				{part.slice(1, -1)}
			</code>
		) : (
			part
		)
	);
}

export default function ContentCalendarPage() {
	return (
		<>
			<HeaderDocs kicker="Guides" title="Content calendar">
				Plan newsletter issues and the LinkedIn posts around them in one place: copy, visuals, review and planned days. All of it works from
				the dashboard, the REST API and MCP, and none of it sends, schedules or publishes.
			</HeaderDocs>

			<div className="grid max-w-3xl gap-12">
				{CONTENT_CALENDAR_GUIDE.map(({ title, paragraphs, code }, index) => (
					<section key={title} style={{ "--stagger": index + 1 }} className="animate-enter">
						<h2 className="text-xl font-semibold tracking-tight">{title}</h2>
						<div className="mt-4 grid gap-4">
							{paragraphs.map((paragraph) => (
								<p key={paragraph} className="text-[15px] leading-7 text-pretty text-foreground/80">
									<Text>{paragraph}</Text>
								</p>
							))}
							{code && <BlockCode title={code.title} code={JSON.stringify(code.value, null, 2)} />}
						</div>
					</section>
				))}
			</div>
		</>
	);
}
