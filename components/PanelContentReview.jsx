"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { AlertTriangle, Check } from "lucide-react";
import { decideContentReview, requestContentReview, setContentState } from "@/app/(app)/campaigns/calendar/actions";
import BadgeStatus from "@/components/BadgeStatus";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { STATE_LABELS } from "@/lib/content-rules";
import { toast } from "@/lib/toast";

function describeDelivery(item) {
	const { delivery } = item;
	if (delivery.mode === "manual") {
		return delivery.status === "posted" ? "Posted by hand. FlockStack recorded where, and did not post it." : "Not posted. A LinkedIn post is posted by hand: nothing here posts or schedules it.";
	}
	const labels = { no_issue: "No issue linked.", issue_missing: "The linked issue was deleted.", draft: "The issue is a draft: it is not scheduled.", scheduled: "The issue is scheduled by its campaign.", held: "The issue is held for its undo window.", sending: "The issue is sending.", paused: "The issue's send is paused.", sent: "The issue was sent." };
	return labels[delivery.status] ?? `The issue is ${delivery.status}.`;
}

// Where the item is in review and in delivery, which are separate, what stops an approval, and the buttons: ask for a review
// (anyone), approve or ask for changes (the signed-in owner, here). Approving sends, schedules and publishes nothing.
export default function PanelContentReview({ item }) {
	const router = useRouter();
	const [note, setNote] = useState("");
	const [isWorking, startWorking] = useTransition();
	const { readiness, review } = item;

	function run(task, success) {
		startWorking(async () => {
			const result = await task();
			if (result?.error) return void toast.error(result.error);
			if (success) toast.success(success);
			router.refresh();
		});
	}

	return (
		<section className="rounded-xl bg-card shadow-border animate-enter" aria-label="Review">
			<h2 className="flex h-12 items-center justify-between gap-3 px-4 text-sm font-medium">
				Review
				<BadgeStatus status={item.state} label={STATE_LABELS[item.state]} />
			</h2>
			<div className="flex flex-col gap-3 border-t border-border/60 px-4 py-3 text-sm">
				{review.editedAfterApproval && (
					<p role="status" className="flex items-start gap-2 rounded-lg bg-amber-500/15 px-3 py-2 text-amber-900 dark:text-amber-200">
						<AlertTriangle className="mt-0.5 size-4 shrink-0" />
						<span>
							<span className="font-medium">Edited after approval.</span> {review.approvedAt ? "It was approved, then the post changed. " : ""}It needs a new review before it counts as approved.
						</span>
					</p>
				)}
				{review.decision === "changes_requested" && review.note && (
					<p className="rounded-lg bg-muted px-3 py-2">
						<span className="font-medium">Changes requested:</span> {review.note}
					</p>
				)}
				{review.decision === "approved" && review.note && (
					<p className="rounded-lg bg-muted px-3 py-2">
						<span className="font-medium">Approved:</span> {review.note}
					</p>
				)}
				<div>
					<p className="text-xs font-medium text-muted-foreground">Delivery, apart from review</p>
					<p>{describeDelivery(item)}</p>
					{item.campaign && (
						<Link href={`/campaigns/${item.campaign.id}`} className="text-link hover:underline">
							Open the {item.channel === "newsletter" ? "issue" : "source issue"} ({item.campaign.status})
						</Link>
					)}
				</div>
				<div>
					<p className="text-xs font-medium text-muted-foreground">{readiness.blockers.length === 0 ? "Nothing is missing" : "Missing before approval"}</p>
					{readiness.blockers.length === 0 ? (
						<p className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-300">
							<Check className="size-4" /> It can be approved.
						</p>
					) : (
						<ul className="list-disc pl-5">
							{readiness.blockers.map((blocker) => (
								<li key={blocker.code}>{blocker.message}</li>
							))}
						</ul>
					)}
					{readiness.warnings.length > 0 && (
						<ul className="mt-1 list-disc pl-5 text-muted-foreground">
							{readiness.warnings.map((warning) => (
								<li key={warning.code}>{warning.message}</li>
							))}
						</ul>
					)}
				</div>
				<div className="flex flex-wrap gap-2">
					{["idea", "drafting", "changes_requested"].includes(item.state) && (
						<Button type="button" disabled={isWorking || !readiness.canApprove} onClick={() => run(() => requestContentReview(item.id), "Ready for review")}>
							Ask for a review
						</Button>
					)}
					{item.state === "approved" && !review.approvalValid && (
						<Button type="button" disabled={isWorking || !readiness.canApprove} onClick={() => run(() => requestContentReview(item.id), "Ready for review")}>
							Ask for a review
						</Button>
					)}
					{item.state === "idea" && (
						<Button type="button" variant="outline" disabled={isWorking} onClick={() => run(() => setContentState(item.id, "drafting"))}>
							Mark as drafting
						</Button>
					)}
					{["drafting", "ready_for_review", "approved"].includes(item.state) && (
						<Button type="button" variant="ghost" disabled={isWorking} onClick={() => run(() => setContentState(item.id, item.state === "drafting" ? "idea" : "drafting"))}>
							{item.state === "drafting" ? "Back to idea" : "Back to drafting"}
						</Button>
					)}
				</div>
				{["ready_for_review", "approved"].includes(item.state) && (
					<div className="flex flex-col gap-2 border-t border-border/60 pt-3">
						<label htmlFor="review-note" className="text-xs font-medium text-muted-foreground">
							Note (what to change, or a word with the approval)
						</label>
						<Textarea id="review-note" value={note} onChange={(event) => setNote(event.target.value)} maxLength={1000} rows={2} />
						<div className="flex flex-wrap gap-2">
							{item.state === "ready_for_review" && (
								<Button type="button" disabled={isWorking || !readiness.canApprove} onClick={() => run(() => decideContentReview(item.id, "approve", note), "Approved")}>
									Approve
								</Button>
							)}
							<Button type="button" variant="outline" disabled={isWorking} onClick={() => run(() => decideContentReview(item.id, "request_changes", note), "Changes requested")}>
								Request changes
							</Button>
						</div>
						<p className="text-xs text-muted-foreground">Approving sends, schedules and publishes nothing.</p>
					</div>
				)}
			</div>
		</section>
	);
}
