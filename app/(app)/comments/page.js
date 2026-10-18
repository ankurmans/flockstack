import Link from "next/link";
import { redirect } from "next/navigation";
import { MessageSquare } from "lucide-react";
import FormCommentSettings from "@/components/FormCommentSettings";
import HeaderPage from "@/components/HeaderPage";
import RowComment from "@/components/RowComment";
import SelectIssueComments from "@/components/SelectIssueComments";
import StateEmpty from "@/components/StateEmpty";
import { scoped } from "@/lib/account-scope";
import { runDashboardAction } from "@/lib/actions/dashboard";
import { PUBLISHED_STATUSES } from "@/lib/archive-issues";
import { formatDate, formatNumber } from "@/lib/format";
import { ADD_NEWSLETTER_PATH } from "@/lib/newsletters";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";
import { cn } from "@/lib/utils";
import Campaign from "@/models/Campaign";

export const metadata = { title: "Comments" };

const FILTERS = [
	{ key: "all", label: "All", input: {} },
	{ key: "held", label: "Waiting for you", input: { status: "held" } },
	{ key: "reported", label: "Reported", input: { reported: true } },
	{ key: "hidden", label: "Hidden", input: { status: "hidden" } },
	{ key: "removed", label: "Removed", input: { status: "removed" } },
];
const ISSUES_SHOWN = 8;

// The open newsletter's comments across its issues: what waits for the owner, what readers reported, and the settings.
// Hiding and removing ask for a reason, which the comment's writer reads.
export default async function CommentsPage({ searchParams }) {
	const { account, selected } = await getSelectedNewsletter();
	if (!selected) redirect(ADD_NEWSLETTER_PATH);
	const { filter: filterKey, cursor } = await searchParams;
	const filter = FILTERS.find(({ key }) => key === filterKey) ?? FILTERS[0];
	const newsletter = String(selected._id);

	const [list, reports, issues] = await Promise.all([
		runDashboardAction("list_comments", { newsletter, ...filter.input, ...(typeof cursor === "string" && { cursor }) }),
		runDashboardAction("list_comment_reports", { newsletter, status: "open", limit: 100 }),
		Campaign.find(scoped(account, { newsletterId: selected._id, status: { $in: PUBLISHED_STATUSES }, archiveSlug: { $type: "string" }, audience: { $ne: "paid" } }))
			.sort({ sentAt: -1, startedAt: -1 })
			.limit(ISSUES_SHOWN)
			.select({ subject: 1, comments: 1, sentAt: 1, startedAt: 1 })
			.lean(),
	]);
	const output = list.output;
	const reportsByComment = Map.groupBy(reports.output?.reports ?? [], ({ commentId }) => commentId);

	return (
		<>
			<HeaderPage title="Comments" />
			<div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
				{output && <FormCommentSettings key={newsletter} newsletterId={newsletter} settings={output.settings} />}

				{output?.settings.enabled && issues.length > 0 && (
					<section style={{ "--stagger": 2 }} className="animate-enter">
						<h2 className="mb-1 text-sm font-medium">Issues</h2>
						<p className="mb-3 text-sm text-pretty text-muted-foreground">
							Each issue follows the newsletter&apos;s setting unless you choose otherwise. Turn an issue off to close its thread. An issue for paid
							subscribers only has a teaser page, with no comments.
						</p>
						<ul className="overflow-hidden rounded-xl shadow-border">
							{issues.map((issue) => (
								<li key={String(issue._id)} className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 bg-card px-4 py-2.5 last:border-b-0">
									<span className="min-w-0 flex-1 basis-40">
										<span className="block truncate text-sm font-medium">{issue.subject || "Untitled"}</span>
										<span className="block text-xs text-muted-foreground tabular-nums">{formatDate(issue.sentAt ?? issue.startedAt)}</span>
									</span>
									<SelectIssueComments newsletterId={newsletter} campaignId={String(issue._id)} subject={issue.subject ?? ""} value={issue.comments ?? null} followsOn={output.settings.enabled} />
								</li>
							))}
						</ul>
					</section>
				)}

				{output && (
					<section style={{ "--stagger": 3 }} className="animate-enter">
						<h2 className="mb-3 text-sm font-medium">Recent comments</h2>
						<nav aria-label="Filter comments" className="mb-4 flex flex-wrap gap-1.5">
							{FILTERS.map(({ key, label }) => {
								const count = { held: output.counts.held, reported: output.counts.reported, hidden: output.counts.hidden, removed: output.counts.removed }[key];
								return (
									<Link
										key={key}
										href={key === "all" ? "/comments" : `/comments?filter=${key}`}
										aria-current={filter.key === key ? "page" : undefined}
										className={cn(
											"inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm font-medium transition-colors duration-150",
											filter.key === key ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
										)}
									>
										{label}
										{count > 0 && <span className="text-xs tabular-nums text-muted-foreground">{formatNumber(count)}</span>}
									</Link>
								);
							})}
						</nav>
						{output.comments.length === 0 ? (
							<StateEmpty icon={MessageSquare} title={filter.key === "all" ? "No comments yet" : "Nothing here"} />
						) : (
							<ul className="flex flex-col gap-3">
								{output.comments.map((comment) => (
									<RowComment key={comment.id} comment={comment} reports={reportsByComment.get(comment.id) ?? []} />
								))}
							</ul>
						)}
						{output.nextCursor && (
							<Link
								href={`/comments?${new URLSearchParams({ ...(filter.key !== "all" && { filter: filter.key }), cursor: output.nextCursor })}`}
								className="mt-4 inline-flex h-9 items-center rounded-lg px-3 text-sm text-muted-foreground hover:bg-muted/60 hover:text-foreground"
							>
								Older comments
							</Link>
						)}
					</section>
				)}
			</div>
		</>
	);
}
