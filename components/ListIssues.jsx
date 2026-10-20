import BadgeDate from "@/components/BadgeDate";
import CardIssue from "@/components/CardIssue";
import { Badge } from "@/components/ui/badge";
import { getIssueDate } from "@/lib/archive-issues";

// A list of issues in the theme's way: cards with pictures, or for the minimal theme a plain list of titles.
export default function ListIssues({ issues, newsletter, urls, theme }) {
	if (theme === "minimal") {
		return (
			<ol className="divide-y divide-border/60 border-y border-border/60">
				{issues.map((issue) => (
					<li key={issue._id.toString()}>
						<a href={urls.post(issue.archiveSlug)} className="group flex flex-col gap-1 py-5 sm:flex-row sm:items-baseline sm:gap-6">
							<span className="w-28 shrink-0 text-sm text-muted-foreground tabular-nums">
								{getIssueDate(issue) && <BadgeDate date={getIssueDate(issue)} />}
							</span>
							<span className="flex min-w-0 flex-col gap-1">
								<span className="font-medium text-balance decoration-foreground/30 underline-offset-4 group-hover:underline">
									{issue.subject}
									{issue.audience === "paid" && (
										<Badge variant="secondary" className="ml-2 align-middle">
											Paid
										</Badge>
									)}
								</span>
								{issue.previewText && <span className="line-clamp-2 text-sm text-muted-foreground text-pretty">{issue.previewText}</span>}
							</span>
						</a>
					</li>
				))}
			</ol>
		);
	}
	return (
		<ol className="grid gap-x-8 gap-y-12 sm:grid-cols-2 lg:grid-cols-3">
			{issues.map((issue) => (
				<li key={issue._id.toString()}>
					<CardIssue issue={issue} newsletter={newsletter} href={urls.post(issue.archiveSlug)} />
				</li>
			))}
		</ol>
	);
}
