import { formatNumber } from "@/lib/format";

// What a survey's readers answered, question by question: get_survey's summary.
export default function CardSurveySummary({ responses, summary }) {
	return (
		<section className="h-fit rounded-xl bg-card shadow-border lg:sticky lg:top-6">
			<h2 className="flex h-12 items-center justify-between px-4 text-sm font-medium">
				Answers
				<span className="text-xs font-normal text-muted-foreground tabular-nums">
					{formatNumber(responses)} {responses === 1 ? "response" : "responses"}
				</span>
			</h2>
			<ol className="flex flex-col divide-y divide-border/60 border-t border-border/60">
				{summary.map((question) => {
					const most = Math.max(1, ...(question.counts ?? []).map(({ count }) => count));
					return (
						<li key={question.id} className="flex flex-col gap-2 p-4 text-sm">
							<p className="font-medium text-pretty">{question.label}</p>
							{question.average !== undefined && question.average !== null && (
								<p className="text-muted-foreground tabular-nums">
									Average {question.average}
									{question.nps !== undefined && question.nps !== null && ` · NPS ${question.nps}`}
								</p>
							)}
							{question.counts && (
								<ul className="flex flex-col gap-1">
									{question.counts.map(({ option, count }) => (
										<li key={option} className="grid grid-cols-[minmax(0,8rem)_1fr_auto] items-center gap-2 text-xs">
											<span className="truncate">{option}</span>
											<span className="h-1.5 rounded-full bg-muted">
												<span className="block h-full rounded-full bg-foreground/70" style={{ width: `${(count / most) * 100}%` }} />
											</span>
											<span className="tabular-nums text-muted-foreground">{formatNumber(count)}</span>
										</li>
									))}
								</ul>
							)}
							{question.latest && (
								<ul className="flex flex-col gap-1 text-muted-foreground">
									{question.latest.length === 0 ? <li>No answers yet</li> : question.latest.map((answer, index) => <li key={index} className="text-pretty">“{answer}”</li>)}
								</ul>
							)}
						</li>
					);
				})}
			</ol>
		</section>
	);
}
