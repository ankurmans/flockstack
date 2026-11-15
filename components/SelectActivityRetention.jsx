"use client";

import { useState, useTransition } from "react";
import { setActivityRetention } from "@/app/(app)/agent-activity/actions";
import { ACTIVITY_PURGE_PER_RUN, ACTIVITY_RETENTION_CHOICES, ACTIVITY_RETENTION_DAYS } from "@/lib/agent-activity-rules";
import { toast } from "@/lib/toast";

// How long the agent activity log keeps entries. Owner only; a shorter choice deletes what is older at the next hourly purge.
export default function SelectActivityRetention({ days }) {
	const [value, setValue] = useState(days);
	const [isPending, startTransition] = useTransition();

	function change(next) {
		const before = value;
		setValue(next);
		startTransition(async () => {
			const result = await setActivityRetention(next);
			if (result?.error) {
				setValue(before);
				toast.error(result.error);
			} else toast.success(`Agent activity is kept ${next} days`);
		});
	}

	return (
		<section className="flex flex-col gap-2 rounded-xl bg-card p-4 shadow-border sm:flex-row sm:items-center sm:justify-between sm:p-5">
			<div>
				<h2 className="text-sm font-medium">Keep agent activity for</h2>
				<p className="mt-1 max-w-xl text-xs text-pretty text-muted-foreground">
					{ACTIVITY_RETENTION_DAYS} days unless you choose. A shorter choice deletes older entries at the next hourly cleanup, at most{" "}
					{ACTIVITY_PURGE_PER_RUN.toLocaleString("en-US")} an hour for each choice.
				</p>
			</div>
			<select
				aria-label="Keep agent activity for"
				value={value}
				disabled={isPending}
				onChange={(event) => change(Number(event.target.value))}
				className="h-9 rounded-lg bg-background px-2 text-sm shadow-border"
			>
				{ACTIVITY_RETENTION_CHOICES.map((choice) => (
					<option key={choice} value={choice}>
						{choice} days
					</option>
				))}
			</select>
		</section>
	);
}
