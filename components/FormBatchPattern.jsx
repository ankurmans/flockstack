"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { applyBatchPattern, saveBatchPattern } from "@/app/(app)/campaigns/calendar/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FUNNEL_STAGES } from "@/lib/content-rules";
import { toast } from "@/lib/toast";

const DAYS = [
	[1, "Mon"],
	[2, "Tue"],
	[3, "Wed"],
	[4, "Thu"],
	[5, "Fri"],
	[6, "Sat"],
	[7, "Sun"],
];

function toValues(pattern, timeZone) {
	return {
		stages: pattern?.stages?.join(", ") ?? "",
		weekdays: pattern?.cadence?.weekdays ?? [],
		everyDays: String(pattern?.cadence?.everyDays ?? 1),
		time: pattern?.cadence?.time ?? "",
		timeZone: pattern?.cadence?.timeZone ?? timeZone,
		startDate: "",
		matchStages: false,
	};
}

// A recurring pattern for the batch: the funnel stages in the order they repeat, and when slots fall. Saved on the batch, it does
// nothing until Apply, which gives items without a day their planned days; Preview shows that without writing it.
export default function FormBatchPattern({ batchId, pattern, timeZone }) {
	const router = useRouter();
	const [values, setValues] = useState(() => toValues(pattern, timeZone));
	const [preview, setPreview] = useState(null);
	const [isWorking, startWorking] = useTransition();
	const stages = values.stages.split(/[\s,]+/).map((stage) => stage.toUpperCase()).filter(Boolean);
	const body = { ...values, stages };
	const isValid = stages.length > 0 && stages.every((stage) => FUNNEL_STAGES.includes(stage));

	function run(task, success) {
		startWorking(async () => {
			const result = await task();
			if (result?.error) return void toast.error(result.error);
			if (result.result) setPreview(result.result);
			if (success) toast.success(success(result));
			router.refresh();
		});
	}

	return (
		<form className="grid gap-3 px-4 py-3" onSubmit={(event) => event.preventDefault()}>
			<label className="flex flex-col gap-1 text-sm font-medium">
				Stages, in the order they repeat
				<Input value={values.stages} onChange={(event) => setValues((current) => ({ ...current, stages: event.target.value }))} placeholder="TOFU, MOFU, BOFU, TOFU, TOFU" />
				<span className="text-xs font-normal text-muted-foreground">TOFU, MOFU or BOFU, separated by commas. The pattern repeats from the first.</span>
			</label>
			<fieldset className="flex flex-wrap gap-x-3 gap-y-1">
				<legend className="mb-1 text-sm font-medium">Days</legend>
				{DAYS.map(([day, label]) => (
					<label key={day} className="flex items-center gap-1.5 text-sm">
						<input type="checkbox" checked={values.weekdays.includes(day)} onChange={(event) => setValues((current) => ({ ...current, weekdays: event.target.checked ? [...current.weekdays, day] : current.weekdays.filter((one) => one !== day) }))} />
						{label}
					</label>
				))}
			</fieldset>
			<div className="grid grid-cols-3 gap-3">
				<label className="flex flex-col gap-1 text-xs text-muted-foreground">
					Or every N days
					<Input type="number" min="1" max="60" value={values.everyDays} onChange={(event) => setValues((current) => ({ ...current, everyDays: event.target.value }))} disabled={values.weekdays.length > 0} />
				</label>
				<label className="flex flex-col gap-1 text-xs text-muted-foreground">
					Time
					<Input type="time" value={values.time} onChange={(event) => setValues((current) => ({ ...current, time: event.target.value }))} />
				</label>
				<label className="flex flex-col gap-1 text-xs text-muted-foreground">
					Timezone
					<Input value={values.timeZone} onChange={(event) => setValues((current) => ({ ...current, timeZone: event.target.value }))} />
				</label>
			</div>
			<div className="flex flex-wrap items-end gap-3">
				<label className="flex flex-col gap-1 text-xs text-muted-foreground">
					Start on
					<Input type="date" value={values.startDate} onChange={(event) => setValues((current) => ({ ...current, startDate: event.target.value }))} className="w-40" />
				</label>
				<label className="flex items-center gap-1.5 pb-2 text-sm">
					<input type="checkbox" checked={values.matchStages} onChange={(event) => setValues((current) => ({ ...current, matchStages: event.target.checked }))} />
					Pick items by stage
				</label>
			</div>
			<div className="flex flex-wrap gap-2">
				<Button type="button" variant="outline" disabled={isWorking || !isValid} onClick={() => run(() => saveBatchPattern(batchId, body), () => "Pattern saved")}>
					Save the pattern
				</Button>
				<Button type="button" variant="outline" disabled={isWorking || !isValid || !values.startDate} onClick={() => run(() => applyBatchPattern(batchId, { ...body, dryRun: true }))}>
					Preview
				</Button>
				<Button type="button" disabled={isWorking || !isValid || !values.startDate} onClick={() => run(() => applyBatchPattern(batchId, body), (result) => `${result.result.applied} planned`)}>
					Apply to items without a day
				</Button>
			</div>
			<p className="text-xs text-muted-foreground">Applying only gives planned days. It never sends, schedules or publishes anything.</p>
			{preview && (
				<div className="rounded-lg bg-muted/50 p-3 text-sm" role="status">
					<p className="font-medium">{preview.dryRun ? "Preview, nothing changed" : `${preview.applied} planned`}</p>
					<ul className="mt-1 flex flex-col gap-0.5">
						{preview.assignments.map((one) => (
							<li key={one.id}>
								{one.date}
								{one.time && ` ${one.time}`}: {one.title || "Untitled"} <span className="text-muted-foreground">(wants {one.patternStage}, is {one.funnelStage ?? "no stage"})</span>
							</li>
						))}
					</ul>
					{preview.mismatches.length > 0 && <p className="mt-1 text-muted-foreground">{preview.mismatches.length} items have a different stage from the pattern&apos;s.</p>}
					{preview.unassigned.length > 0 && <p className="mt-1 text-muted-foreground">{preview.unassigned.length} items have no slot.</p>}
				</div>
			)}
		</form>
	);
}
