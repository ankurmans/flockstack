"use client";

import { useId, useState, useTransition } from "react";
import { moveContentItem } from "@/app/(app)/campaigns/calendar/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/lib/toast";

// Moving an item to a day without dragging: a date, an optional time, and a button. Only the plan changes; nothing is sent or scheduled.
// isFolded: behind a Move disclosure, for the week and the agenda, where there is a form for every item.
export default function FormMoveItem({ id, title, date = "", time = "", timeZone, isFolded = false }) {
	const fieldId = useId();
	const [values, setValues] = useState({ date, time });
	const [isMoving, startMoving] = useTransition();

	function move(next) {
		startMoving(async () => {
			const result = await moveContentItem(id, { ...next, timeZone });
			if (result?.error) return void toast.error(result.error);
			toast.success(next.date ? `Planned for ${next.date}` : "Back in the backlog");
		});
	}

	const form = (
		<form
			className="flex flex-wrap items-end gap-1.5"
			onSubmit={(event) => {
				event.preventDefault();
				move(values);
			}}
		>
			<div className="flex flex-col gap-0.5">
				<label htmlFor={`${fieldId}-date`} className="text-xs text-muted-foreground">
					<span className="sr-only">Plan {title} for </span>Day
				</label>
				<Input id={`${fieldId}-date`} type="date" value={values.date} onChange={(event) => setValues((current) => ({ ...current, date: event.target.value }))} className="h-8 w-32 max-w-full" required />
			</div>
			<div className="flex flex-col gap-0.5">
				<label htmlFor={`${fieldId}-time`} className="text-xs text-muted-foreground">
					Time
				</label>
				<Input id={`${fieldId}-time`} type="time" value={values.time} onChange={(event) => setValues((current) => ({ ...current, time: event.target.value }))} className="h-8 w-24 max-w-full" />
			</div>
			<Button type="submit" size="sm" variant="outline" disabled={isMoving || !values.date}>
				Move
			</Button>
			{date && (
				<Button type="button" size="sm" variant="ghost" disabled={isMoving} onClick={() => move({ date: "", time: "" })}>
					Back to backlog
				</Button>
			)}
		</form>
	);

	if (!isFolded) return form;

	return (
		<details className="text-xs">
			<summary className="cursor-pointer text-muted-foreground hover:text-foreground">
				Move<span className="sr-only"> {title}</span>
			</summary>
			<div className="mt-1.5">{form}</div>
		</details>
	);
}
