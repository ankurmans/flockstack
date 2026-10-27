"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { blockReader, decideComment, unblockReader } from "@/app/(app)/comments/actions";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/format";
import { toast } from "@/lib/toast";

const STATUS_LABELS = { published: "Showing", held: "Waiting for you", hidden: "Hidden", removed: "Removed" };
const DECIDED = { rules: "Held by your review setting", creator: "Your decision", author: "Deleted by its author" };

// One comment in the dashboard: who wrote it, where, its state and the reason, any reports, and what the owner can do.
// Hide, remove and block ask for a reason first, since the writer reads it.
export default function RowComment({ comment, reports = [] }) {
	const router = useRouter();
	const [mode, setMode] = useState(null);
	const [reason, setReason] = useState("");
	const [isPending, startTransition] = useTransition();
	const decisionLabel = comment.decidedBy === "rules" && comment.replyRuleDecision ? "Reply Rules decision, reviewable" : DECIDED[comment.decidedBy];
	const isAuthorDeleted = comment.status === "removed" && comment.decidedBy === "author";

	function run(task, success) {
		startTransition(async () => {
			const result = await task();
			if (result?.error) return void toast.error(result.error);
			toast.success(success);
			setMode(null);
			setReason("");
			router.refresh();
		});
	}

	const decide = (action, success) => run(() => decideComment({ id: comment.id, action, reason }), success);

	return (
		<li className="rounded-xl bg-card p-4 shadow-border">
			<div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
				<p className="min-w-0 text-sm">
					<span className="font-medium">{comment.authorName}</span>
					{comment.author.email && <span className="ml-2 break-all text-muted-foreground">{comment.author.email}</span>}
				</p>
				<span className="text-xs text-muted-foreground tabular-nums">{formatDate(comment.createdAt)}</span>
			</div>
			<p className="mt-0.5 text-xs text-muted-foreground">
				{comment.parentId ? "Reply" : "Comment"} on{" "}
				{comment.url ? (
					<a href={comment.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4 hover:text-foreground">
						{comment.issueSubject || "an issue"}
					</a>
				) : (
					comment.issueSubject || "an issue"
				)}
				{comment.edited && " · edited"}
			</p>
			{comment.body && <p className="mt-3 text-sm leading-relaxed break-words whitespace-pre-line text-foreground/90">{comment.body}</p>}

			<div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
				<span className={comment.status === "held" ? "rounded-md bg-amber-500/15 px-2 py-0.5 font-medium text-amber-800 dark:text-amber-300" : "rounded-md bg-muted px-2 py-0.5 font-medium text-muted-foreground"}>
					{STATUS_LABELS[comment.status]}
				</span>
				{comment.openReports > 0 && (
					<span className="rounded-md bg-destructive/10 px-2 py-0.5 font-medium text-destructive">
						{comment.openReports} {comment.openReports === 1 ? "report" : "reports"}
					</span>
				)}
				{comment.author.isBlocked && <span className="rounded-md bg-muted px-2 py-0.5 font-medium text-muted-foreground">Commenting off for them</span>}
			</div>
			{comment.reason && (
				<p className="mt-2 text-sm text-pretty text-muted-foreground">
					{decisionLabel ? `${decisionLabel}: ` : "Reason: "}
					{comment.reason}
				</p>
			)}
			{reports.length > 0 && (
				<ul className="mt-2 flex flex-col gap-1 text-sm text-muted-foreground">
					{reports.map((report) => (
						<li key={report.id}>
							{report.reporter.name ?? "A reader"} reported it: {report.reason ?? "no reason given"}
						</li>
					))}
				</ul>
			)}

			{!isAuthorDeleted && (
				<div className="mt-3 flex flex-wrap items-center gap-2">
					{comment.status !== "published" && (
						<Button size="sm" variant="outline" disabled={isPending} onClick={() => decide("approve", "Comment approved")}>
							Approve
						</Button>
					)}
					{comment.status === "published" && comment.openReports > 0 && (
						<Button size="sm" variant="outline" disabled={isPending} onClick={() => decide("approve", "Reports dismissed")}>
							Keep it
						</Button>
					)}
					{["published", "held"].includes(comment.status) && (
						<Button size="sm" variant="outline" disabled={isPending} onClick={() => setMode(mode === "hide" ? null : "hide")}>
							Hide
						</Button>
					)}
					{comment.status !== "removed" && (
						<Button size="sm" variant="outline" disabled={isPending} onClick={() => setMode(mode === "remove" ? null : "remove")}>
							Remove
						</Button>
					)}
					{comment.author.contactId &&
						(comment.author.isBlocked ? (
							<Button size="sm" variant="ghost" disabled={isPending} onClick={() => run(() => unblockReader({ contactId: comment.author.contactId }), "Commenting is back on for them")}>
								Let them comment again
							</Button>
						) : (
							<Button size="sm" variant="ghost" disabled={isPending} onClick={() => setMode(mode === "block" ? null : "block")}>
								Block commenter
							</Button>
						))}
				</div>
			)}

			{mode && (
				<form
					className="mt-3 flex flex-col gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						if (mode === "block") run(() => blockReader({ contactId: comment.author.contactId, reason }), "Commenter blocked");
						else decide(mode, mode === "hide" ? "Comment hidden" : "Comment removed");
					}}
				>
					<label htmlFor={`reason-${comment.id}`} className="text-sm font-medium">
						{mode === "block" ? "Why is commenting off for them?" : `Why are you ${mode === "hide" ? "hiding" : "removing"} it?`}
					</label>
					<textarea
						id={`reason-${comment.id}`}
						required
						rows={2}
						maxLength={500}
						value={reason}
						onChange={(event) => setReason(event.target.value)}
						className="min-h-16 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-base outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring md:text-sm"
					/>
					<p className="text-xs text-muted-foreground">
						{mode === "block"
							? "They read this when they try to comment. They stay subscribed and keep getting your emails."
							: "The writer reads this, on the issue's page and in an email."}
					</p>
					<div className="flex gap-2">
						<Button type="submit" size="sm" disabled={isPending || !reason.trim()}>
							{isPending ? <Loader2 className="animate-spin" /> : mode === "hide" ? "Hide comment" : mode === "remove" ? "Remove comment" : "Block commenter"}
						</Button>
						<Button type="button" size="sm" variant="ghost" onClick={() => setMode(null)}>
							Cancel
						</Button>
					</div>
				</form>
			)}
		</li>
	);
}
