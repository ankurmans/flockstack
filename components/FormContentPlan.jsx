"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { moveContentItem } from "@/app/(app)/campaigns/calendar/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/lib/toast";

// The item's planned day, time, timezone and place among the day's items, with the moves so far. A plan is editorial: this never
// sends, schedules or publishes anything, and it keeps an approval.
export default function FormContentPlan({ item, defaultTimeZone }) {
	const router = useRouter();
	const [values, setValues] = useState({ date: item.plannedDate ?? "", time: item.plannedTime ?? "", timeZone: item.timeZone ?? defaultTimeZone, position: item.slot ? String(item.slot) : "" });
	const [isMoving, startMoving] = useTransition();
	const set = (field) => (event) => setValues((current) => ({ ...current, [field]: event.target.value }));

	function move(next, success) {
		startMoving(async () => {
			const result = await moveContentItem(item.id, next);
			if (result?.error) return void toast.error(result.error);
			toast.success(success);
			router.refresh();
		});
	}

	return (
		<section className="rounded-xl bg-card shadow-border animate-enter" aria-label="Plan">
			<h2 className="flex h-12 items-center px-4 text-sm font-medium">Planned day</h2>
			<form
				className="grid gap-3 border-t border-border/60 px-4 py-3"
				onSubmit={(event) => {
					event.preventDefault();
					move({ ...values, position: Number(values.position) || undefined }, `Planned for ${values.date}`);
				}}
			>
				<div className="grid grid-cols-2 gap-3">
					<label className="flex flex-col gap-1 text-xs text-muted-foreground">
						Day
						<Input type="date" value={values.date} onChange={set("date")} required />
					</label>
					<label className="flex flex-col gap-1 text-xs text-muted-foreground">
						Time (optional)
						<Input type="time" value={values.time} onChange={set("time")} />
					</label>
				</div>
				<div className="grid grid-cols-[minmax(0,1fr)_5rem] gap-3">
					<label className="flex flex-col gap-1 text-xs text-muted-foreground">
						Timezone
						<Input value={values.timeZone} onChange={set("timeZone")} maxLength={64} />
					</label>
					<label className="flex flex-col gap-1 text-xs text-muted-foreground">
						Place
						<Input type="number" min="1" max="100" value={values.position} onChange={set("position")} />
					</label>
				</div>
				<div className="flex flex-wrap gap-2">
					<Button type="submit" disabled={isMoving || !values.date}>
						{item.plannedDate ? "Move" : "Plan"}
					</Button>
					{item.plannedDate && (
						<Button type="button" variant="ghost" disabled={isMoving} onClick={() => move({ date: "" }, "Back in the backlog")}>
							Back to backlog
						</Button>
					)}
				</div>
				<p className="text-xs text-muted-foreground">A planned day is an intention. It doesn&apos;t send, schedule or publish anything.{item.plannedAt && ` Planned time in UTC: ${item.plannedAt.slice(0, 16).replace("T", " ")}.`}</p>
				{item.moves.length > 0 && (
					<details className="text-xs text-muted-foreground">
						<summary className="cursor-pointer">Moves ({item.moves.length})</summary>
						<ul className="mt-1 flex flex-col gap-0.5">
							{item.moves.toReversed().map((move, index) => (
								<li key={index}>
									{move.from || "Backlog"} to {move.to || "backlog"} ({move.by})
								</li>
							))}
						</ul>
					</details>
				)}
			</form>
		</section>
	);
}
