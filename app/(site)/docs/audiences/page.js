import BlockCode from "@/components/BlockCode";
import HeaderDocs from "@/components/HeaderDocs";
import { AUDIENCE_GUIDE } from "@/lib/docs/audience-guide";
import { getDocsPageMetadata } from "@/lib/docs/llms";

export const metadata = getDocsPageMetadata("/docs/audiences");

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

export default function AudiencesPage() {
	return (
		<>
			<HeaderDocs kicker="Guides" title="Tags, segments and automations">
				Label contacts, save audiences as rules, and send series of emails that start on their own. All of it works from the dashboard, the
				REST API and MCP.
			</HeaderDocs>

			<div className="grid max-w-3xl gap-12">
				{AUDIENCE_GUIDE.map(({ title, paragraphs, code }, index) => (
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
