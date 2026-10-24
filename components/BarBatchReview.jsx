"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { approveReadyItems, requestBatchReview } from "@/app/(app)/campaigns/calendar/actions";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";

// Asking for the review of a whole batch, and the owner approving what is ready in one go. Approval is editorial: it sends,
// schedules and publishes nothing.
export default function BarBatchReview({ batchId, readyCount }) {
	const router = useRouter();
	const [isWorking, startWorking] = useTransition();

	function run(task, describe) {
		startWorking(async () => {
			const result = await task();
			if (result?.error) return void toast.error(result.error);
			toast.success(describe(result));
			router.refresh();
		});
	}

	return (
		<div className="flex flex-wrap gap-2">
			<Button
				type="button"
				variant="outline"
				disabled={isWorking}
				onClick={() => run(() => requestBatchReview(batchId), (result) => `${result.requested} asked for review${result.blocked ? `, ${result.blocked} can't be yet` : ""}`)}
			>
				Ask for a review of all
			</Button>
			<Button type="button" disabled={isWorking || readyCount === 0} onClick={() => run(() => approveReadyItems(batchId), (result) => `${result.approved} approved`)}>
				Approve all that are ready{readyCount > 0 ? ` (${readyCount})` : ""}
			</Button>
		</div>
	);
}
