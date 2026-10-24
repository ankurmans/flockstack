"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { restoreContentRevision } from "@/app/(app)/campaigns/calendar/actions";
import { Button } from "@/components/ui/button";
import TimeLocal from "@/components/TimeLocal";
import { toast } from "@/lib/toast";

const WHEN = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };

// The states the item's content was in, newest first. Restoring brings one back as a new revision.
export default function PanelContentRevisions({ itemId, revisions }) {
	const router = useRouter();
	const [isRestoring, startRestoring] = useTransition();

	function restore(revision) {
		startRestoring(async () => {
			const result = await restoreContentRevision(itemId, revision.id);
			if (result?.error) return void toast.error(result.error);
			toast.success(result.skipped.length > 0 ? `Restored, without ${result.skipped.join(" and ")}` : "Restored");
			router.refresh();
		});
	}

	return (
		<section className="rounded-xl bg-card shadow-border animate-enter" aria-label="Revisions">
			<h2 className="flex h-12 items-center px-4 text-sm font-medium">Revisions</h2>
			<ul className="divide-y divide-border/60 border-t border-border/60">
				{revisions.map((revision, index) => (
					<li key={revision.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
						<span className="min-w-0">
							<span className="block text-xs text-muted-foreground tabular-nums">
								Version {revision.version} · <TimeLocal value={revision.createdAt} options={WHEN} />
							</span>
							<span className="block truncate">
								{revision.reason === "create" ? "Created" : revision.reason === "restore" ? "Restored" : revision.changedFields.join(", ") || "Changed"}
								{revision.by && <span className="text-muted-foreground"> · {revision.by}</span>}
							</span>
						</span>
						{index > 0 && (
							<Button type="button" variant="ghost" size="sm" disabled={isRestoring} onClick={() => restore(revision)} aria-label={`Restore version ${revision.version}`}>
								Restore
							</Button>
						)}
					</li>
				))}
			</ul>
		</section>
	);
}
