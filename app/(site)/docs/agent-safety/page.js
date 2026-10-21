import BlockCode from "@/components/BlockCode";
import HeaderDocs from "@/components/HeaderDocs";
import { getAppUrl } from "@/lib/config";
import { getAgentSafetyGuide } from "@/lib/docs/agent-safety";
import { getDocsPageMetadata } from "@/lib/docs/pages";

export const metadata = getDocsPageMetadata("/docs/agent-safety");

export default function AgentSafetyPage() {
	const sections = getAgentSafetyGuide(getAppUrl());

	return (
		<>
			<HeaderDocs kicker="Guides" title="Agent safety">
				Let an AI agent run your newsletter without handing it the keys. Agents write and prepare; anything that goes out to subscribers or can&apos;t be undone waits
				for your approval.
			</HeaderDocs>

			<div className="grid max-w-4xl gap-12">
				{sections.map(({ id, title, paragraphs = [], table, paragraphs2 = [], code = [] }, index) => (
					<section key={id} id={id} style={{ "--stagger": Math.min(index + 1, 6) }} className="animate-enter scroll-mt-20">
						<h2 className="text-xl font-semibold tracking-tight">{title}</h2>
						<div className="mt-4 grid gap-4">
							{paragraphs.map((paragraph) => (
								<Paragraph key={paragraph}>{paragraph}</Paragraph>
							))}
							{table && <Table head={table.head} rows={table.rows} />}
							{paragraphs2.map((paragraph) => (
								<Paragraph key={paragraph}>{paragraph}</Paragraph>
							))}
							{code.map(({ title: caption, code: body }) => (
								<BlockCode key={caption} title={caption} code={body} />
							))}
						</div>
					</section>
				))}
			</div>
		</>
	);
}

function Paragraph({ children }) {
	return <p className="text-[15px] leading-7 text-pretty text-foreground/80">{children}</p>;
}

function Table({ head, rows }) {
	return (
		<div className="overflow-x-auto rounded-xl shadow-border">
			<table className="w-full text-left text-sm">
				<thead>
					<tr className="border-b border-border/60 text-xs text-muted-foreground">
						{head.map((cell) => (
							<th key={cell} className="py-2 pr-4 pl-4 font-normal">
								{cell}
							</th>
						))}
					</tr>
				</thead>
				<tbody className="divide-y divide-border/60 align-top">
					{rows.map((row) => (
						<tr key={row[0]}>
							{row.map((cell, index) => (
								<td key={`${row[0]}-${head[index]}`} className={index === 0 ? "py-3 pr-4 pl-4 font-medium" : "py-3 pr-4 pl-4 text-muted-foreground"}>
									{cell}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
