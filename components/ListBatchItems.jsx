"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { decideContentReview, reorderContentItems } from "@/app/(app)/campaigns/calendar/actions";
import BadgeStatus from "@/components/BadgeStatus";
import { Button } from "@/components/ui/button";
import { CHANNEL_LABELS, STATE_LABELS } from "@/lib/content-rules";
import { toast } from "@/lib/toast";

// A batch's items in order, each with where it stands: its state, its day, what is missing, and, for one in review, the owner's
// two buttons. The arrows reorder the batch. Nothing here sends, schedules or publishes.
export default function ListBatchItems({ batchId, items }) {
	const router = useRouter();
	const [isWorking, startWorking] = useTransition();

	function run(task, success) {
		startWorking(async () => {
			const result = await task();
			if (result?.error) return void toast.error(result.error);
			if (success) toast.success(success);
			router.refresh();
		});
	}

	function move(index, offset) {
		const ids = items.map((item) => item.id);
		[ids[index], ids[index + offset]] = [ids[index + offset], ids[index]];
		run(() => reorderContentItems("batch", ids, batchId));
	}

	if (items.length === 0) return <p className="px-4 py-3 text-sm text-muted-foreground">No items in this batch. Choose it in an item&apos;s Batch field.</p>;

	return (
		<ol className="divide-y divide-border/60">
			{items.map((item, index) => (
				<li key={item.id} className="flex flex-col gap-2 px-4 py-3">
					<div className="flex flex-wrap items-start justify-between gap-2">
						<div className="min-w-0">
							<Link href={`/campaigns/calendar/items/${item.id}`} className="font-medium hover:underline">
								{index + 1}. {item.title || "Untitled"}
							</Link>
							<p className="text-xs text-muted-foreground">
								{CHANNEL_LABELS[item.channel]}
								{item.funnelStage && ` · ${item.funnelStage}`}
								{item.pillar && ` · ${item.pillar}`}
								{" · "}
								{item.plannedDate ? `Planned for ${item.plannedDate}${item.plannedTime ? ` ${item.plannedTime}` : ""}` : "No day yet"}
								{item.campaign && ` · Issue is a ${item.campaign.status}`}
								{item.assetCount > 0 && ` · ${item.assetCount} ${item.assetCount === 1 ? "visual" : "visuals"}`}
							</p>
						</div>
						<div className="flex items-center gap-1">
							<BadgeStatus status={item.state} label={STATE_LABELS[item.state]} />
							<Button type="button" variant="ghost" size="icon-sm" aria-label={`Move ${item.title || "this item"} up`} disabled={isWorking || index === 0} onClick={() => move(index, -1)}>
								<ArrowUp />
							</Button>
							<Button type="button" variant="ghost" size="icon-sm" aria-label={`Move ${item.title || "this item"} down`} disabled={isWorking || index === items.length - 1} onClick={() => move(index, 1)}>
								<ArrowDown />
							</Button>
						</div>
					</div>
					{item.review.editedAfterApproval && <p className="text-xs font-medium text-amber-700 dark:text-amber-300">Edited after approval</p>}
					{item.blockerCount > 0 && <p className="text-xs text-muted-foreground">Missing before it can be approved: {item.blockers.map(({ message }) => message.replace(/\.$/, "")).join("; ")}.</p>}
					{item.state === "ready_for_review" && (
						<div className="flex flex-wrap gap-2">
							<Button type="button" size="sm" disabled={isWorking || !item.canApprove} onClick={() => run(() => decideContentReview(item.id, "approve"), "Approved")}>
								Approve
							</Button>
							<Button type="button" size="sm" variant="outline" disabled={isWorking} onClick={() => run(() => decideContentReview(item.id, "request_changes", ""), "Changes requested")}>
								Request changes
							</Button>
						</div>
					)}
				</li>
			))}
		</ol>
	);
}
