"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pause, Play, Trash2 } from "lucide-react";
import { activateAutomation, deleteAutomation, pauseAutomation, saveAutomation } from "@/app/(app)/automations/actions";
import BadgeStatus from "@/components/BadgeStatus";
import CardEnrollContacts from "@/components/CardEnrollContacts";
import CardSettings from "@/components/CardSettings";
import EditorTrigger, { toTriggerInput } from "@/components/EditorTrigger";
import ListSteps from "@/components/ListSteps";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fromApiSteps, toApiSteps } from "@/lib/automation-editor";
import { formatNumber } from "@/lib/format";
import { toast } from "@/lib/toast";

// An automation: what starts it, its steps as a tree, and how contacts are doing in them. Its trigger and steps are fixed
// while it's active: pause it to change them.
// choices: the newsletter's fields, tags, polls, issues and saved lists (lib/segment-choices.js). segments, automations
// (the others) and products are { id, name or title }.
export default function FormAutomation({ automation, report, choices, segments, automations, products }) {
	const router = useRouter();
	const [name, setName] = useState(automation.name);
	const [trigger, setTrigger] = useState(automation.trigger);
	const [steps, setSteps] = useState(() => fromApiSteps(automation.steps));
	const [openKey, setOpenKey] = useState(null);
	const [isWorking, startWorking] = useTransition();
	const isActive = automation.status === "active";
	const savedKey = useMemo(
		() => JSON.stringify([automation.name, toTriggerInput(automation.trigger), toApiSteps(fromApiSteps(automation.steps), choices.fields)]),
		[automation, choices.fields]
	);
	const currentKey = JSON.stringify([name, toTriggerInput(trigger), toApiSteps(steps, choices.fields)]);
	const isDirty = savedKey !== currentKey;
	const reportByStep = new Map(report.steps.map((step) => [step.id, step]));

	function run(action, message) {
		startWorking(async () => {
			const result = await action();
			if (result?.error) return void toast.error(result.error);
			if (message) toast.success(message);
			router.refresh();
		});
	}

	function save() {
		return saveAutomation(automation.id, isActive ? { name } : { name, trigger: toTriggerInput(trigger), steps: toApiSteps(steps, choices.fields) });
	}

	async function activate() {
		if (isDirty) {
			const saved = await save();
			if (saved?.error) return saved;
		}
		return activateAutomation(automation.id);
	}

	const ctx = { allSteps: steps, setAllSteps: setSteps, isDisabled: isActive, openKey, setOpenKey, reportByStep, choices, segments, automations };

	return (
		<div className="mx-auto grid w-full max-w-5xl grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
			<div className="flex flex-col gap-6">
				<CardSettings title="Automation" action={<BadgeStatus status={automation.status} />}>
					<div className="flex flex-col gap-3 p-4">
						<Input value={name} onChange={(event) => setName(event.target.value)} aria-label="Name" maxLength={100} className="h-9" />
						{automation.pauseReason && (
							<p role="status" className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-pretty text-amber-900 dark:text-amber-100">
								Paused by FlockStack: {automation.pauseReason}. Fix it, then activate it again.
							</p>
						)}
						{isActive && <p className="text-sm text-muted-foreground">It&apos;s active. Pause it to change its trigger or steps.</p>}
					</div>
				</CardSettings>

				<CardSettings title="Starts when" stagger={1}>
					<div className="flex flex-col gap-3 p-4">
						<EditorTrigger trigger={trigger} onChange={setTrigger} segments={segments} choices={choices} products={products} isDisabled={isActive} />
					</div>
				</CardSettings>

				<section className="flex flex-col gap-3" aria-label="Steps">
					<ListSteps steps={steps} ctx={ctx} />
				</section>

				<div className="flex flex-wrap items-center justify-end gap-2">
					<DeleteButton id={automation.id} name={automation.name} />
					<Button variant="outline" onClick={() => run(save, "Saved")} disabled={isWorking || !isDirty || !name.trim()} className="min-w-20">
						{isWorking ? <Loader2 className="animate-spin" /> : "Save"}
					</Button>
					{isActive ? (
						<Button variant="outline" onClick={() => run(() => pauseAutomation(automation.id), "Paused")} disabled={isWorking}>
							<Pause data-icon="inline-start" />
							Pause
						</Button>
					) : (
						<Button onClick={() => run(activate, "Activated")} disabled={isWorking || !name.trim()}>
							<Play data-icon="inline-start" />
							{automation.status === "paused" ? "Resume" : "Activate"}
						</Button>
					)}
				</div>
			</div>

			<div className="flex flex-col gap-6">
				<CardContacts report={report} />
				{isActive && ["manual", "api"].includes(automation.trigger.type) && <CardEnrollContacts id={automation.id} />}
			</div>
		</div>
	);
}

function DeleteButton({ id, name }) {
	const router = useRouter();
	const [isPending, startTransition] = useTransition();

	function remove() {
		if (!window.confirm(`Delete ${name}? Contacts in it are taken out and nothing more is sent.`)) return;
		startTransition(async () => {
			const result = await deleteAutomation(id);
			if (result?.error) return void toast.error(result.error);
			toast.success("Automation deleted");
			router.push("/automations");
		});
	}

	return (
		<Button variant="ghost" onClick={remove} disabled={isPending} className="mr-auto text-muted-foreground hover:text-destructive">
			<Trash2 data-icon="inline-start" />
			Delete
		</Button>
	);
}

function CardContacts({ report }) {
	const { enrollments } = report.automation;
	return (
		<aside className="h-fit rounded-xl bg-card shadow-border lg:sticky lg:top-6">
			<h2 className="flex h-12 items-center px-4 text-sm font-medium">Contacts</h2>
			<div className="border-t border-border/60 p-4">
				<dl className="grid grid-cols-2 gap-x-2 gap-y-4 text-center">
					<Count label="Entered" value={report.entered} />
					<Count label="In it" value={enrollments.active} />
					<Count label="Finished" value={enrollments.completed} />
					<Count label="Left" value={enrollments.exited} />
				</dl>
				{Object.entries(report.exits).some(([, count]) => count > 0) && (
					<ul className="mt-4 flex flex-col gap-1 text-sm text-muted-foreground">
						{Object.entries(report.exits)
							.filter(([, count]) => count > 0)
							.map(([reason, count]) => (
								<li key={reason} className="flex justify-between gap-4">
									<span>{reason}</span>
									<span className="text-foreground tabular-nums">{formatNumber(count)}</span>
								</li>
							))}
					</ul>
				)}
				{report.variantGroupsTruncated && <p className="mt-4 text-xs text-muted-foreground">Only the 200 most recently sent variant groups are shown; older group results are omitted.</p>}
				<p className="mt-4 text-xs text-pretty text-muted-foreground">Each step shows how many contacts it ran for, how many wait for it, and for a branch or split how many took each path.</p>
			</div>
		</aside>
	);
}

function Count({ label, value }) {
	return (
		<div>
			<dd className="text-xl font-semibold tabular-nums">{formatNumber(value)}</dd>
			<dt className="text-xs text-muted-foreground">{label}</dt>
		</div>
	);
}
