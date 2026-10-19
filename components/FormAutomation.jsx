"use client";

import { useId, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Clock, Loader2, Mail, Pause, Play, Plus, Square, Tag, Trash2 } from "lucide-react";
import { activateAutomation, deleteAutomation, pauseAutomation, saveAutomation } from "@/app/(app)/automations/actions";
import BadgeStatus from "@/components/BadgeStatus";
import CardSettings from "@/components/CardSettings";
import EditorRich from "@/components/EditorRich";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatNumber } from "@/lib/format";
import { markdownToHtml } from "@/lib/markdown";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const TRIGGERS = {
	subscribed: "A contact subscribes",
	tag_added: "A contact gets a tag",
	segment_joined: "A contact joins a segment",
	date_field: "A date field's day arrives",
};
const STEP_ICONS = { email: Mail, wait: Clock, add_tag: Tag, remove_tag: Tag, end: Square };
const STEP_NAMES = { email: "Send an email", wait: "Wait", add_tag: "Add a tag", remove_tag: "Remove a tag", end: "End" };
let nextKey = 0;

function withKey(step) {
	// An email in Markdown is edited as rich text, and saved as such.
	if (step.type === "email" && step.format === "markdown") return { ...step, _key: `k${nextKey++}`, format: "rich", content: markdownToHtml(step.content ?? "") };
	return { ...step, _key: `k${nextKey++}` };
}

function newStep(type) {
	const base = { _key: `k${nextKey++}`, type };
	if (type === "email") return { ...base, subject: "", previewText: "", format: "rich", content: "" };
	if (type === "wait") return { ...base, amount: 1, unit: "days" };
	if (type === "add_tag" || type === "remove_tag") return { ...base, tag: "" };
	return base;
}

// What update_automation takes: the steps without the editor's own keys.
function toStepInput({ _key, ...step }) {
	return step;
}

function toTriggerInput(trigger) {
	const { type } = trigger;
	if (type === "subscribed") return { type, ...(trigger.tag && { tag: trigger.tag }), ...(trigger.source && { source: trigger.source }) };
	if (type === "tag_added") return { type, tag: trigger.tag ?? "" };
	if (type === "segment_joined") return { type, segment: trigger.segment ?? "", includeExisting: Boolean(trigger.includeExisting) };
	return { type, field: trigger.field ?? "", offsetDays: Number(trigger.offsetDays) || 0, repeat: trigger.repeat ?? "once" };
}

// An automation: what starts it, its steps, and how contacts are doing in them. Its trigger and steps are fixed while
// it's active: pause it to change them.
export default function FormAutomation({ automation, report, segments, dateFields, fields, tags }) {
	const router = useRouter();
	const [name, setName] = useState(automation.name);
	const [trigger, setTrigger] = useState(automation.trigger);
	const [steps, setSteps] = useState(() => automation.steps.map(withKey));
	const [openKey, setOpenKey] = useState(null);
	const [isWorking, startWorking] = useTransition();
	const isActive = automation.status === "active";
	const savedKey = useMemo(() => JSON.stringify([automation.name, automation.trigger, automation.steps.map((step) => ({ ...step, content: step.format === "markdown" ? markdownToHtml(step.content ?? "") : step.content, format: step.format === "markdown" ? "rich" : step.format }))]), [automation]);
	const currentKey = JSON.stringify([name, trigger, steps.map(({ _key, ...step }) => step)]);
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
		return saveAutomation(automation.id, isActive ? { name } : { name, trigger: toTriggerInput(trigger), steps: steps.map(toStepInput) });
	}

	async function activate() {
		if (isDirty) {
			const saved = await save();
			if (saved?.error) return saved;
		}
		return activateAutomation(automation.id);
	}

	function updateStep(key, changes) {
		setSteps((current) => current.map((step) => (step._key === key ? { ...step, ...changes } : step)));
	}

	function move(index, direction) {
		setSteps((current) => {
			const next = [...current];
			[next[index], next[index + direction]] = [next[index + direction], next[index]];
			return next;
		});
	}

	return (
		<div className="mx-auto grid w-full max-w-5xl gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
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
						<TriggerEditor trigger={trigger} onChange={setTrigger} segments={segments} dateFields={dateFields} tags={tags} isDisabled={isActive} />
					</div>
				</CardSettings>

				<section className="flex flex-col gap-3" aria-label="Steps">
					{steps.map((step, index) => {
						const Icon = STEP_ICONS[step.type];
						const isOpen = openKey === step._key;
						const stats = reportByStep.get(step.id);
						return (
							<div key={step._key} className="rounded-xl bg-card shadow-border animate-enter">
								<div className="flex items-center gap-3 px-4 py-3">
									<span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
										<Icon className="size-4" aria-hidden="true" />
									</span>
									<button
										type="button"
										onClick={() => setOpenKey(isOpen ? null : step._key)}
										aria-expanded={isOpen}
										className="min-w-0 flex-1 text-left"
									>
										<span className="block truncate text-sm font-medium">{describe(step)}</span>
										<span className="block truncate text-xs text-muted-foreground">
											{STEP_NAMES[step.type]}
											{stats && stats.waiting > 0 ? ` · ${formatNumber(stats.waiting)} waiting for it` : ""}
											{stats?.sent ? ` · ${formatNumber(stats.sent)} sent, ${formatNumber(stats.opened ?? 0)} opened` : ""}
										</span>
									</button>
									{!isActive && (
										<span className="flex shrink-0 items-center">
											<Button variant="ghost" size="icon-sm" onClick={() => move(index, -1)} disabled={index === 0} aria-label="Move up">
												<ArrowUp />
											</Button>
											<Button variant="ghost" size="icon-sm" onClick={() => move(index, 1)} disabled={index === steps.length - 1} aria-label="Move down">
												<ArrowDown />
											</Button>
											<Button
												variant="ghost"
												size="icon-sm"
												onClick={() => setSteps((current) => current.filter(({ _key }) => _key !== step._key))}
												aria-label="Remove the step"
												className="text-muted-foreground hover:text-destructive"
											>
												<Trash2 />
											</Button>
										</span>
									)}
								</div>
								{isOpen && (
									<div className="border-t border-border/60">
										<StepEditor step={step} onChange={(changes) => updateStep(step._key, changes)} isDisabled={isActive} tags={tags} fields={fields} />
									</div>
								)}
							</div>
						);
					})}
					{!isActive && (
						<div className="flex flex-wrap gap-2">
							{Object.entries(STEP_NAMES).map(([type, label]) => (
								<Button
									key={type}
									variant="outline"
									size="sm"
									onClick={() => {
										const step = newStep(type);
										setSteps((current) => [...current, step]);
										setOpenKey(step._key);
									}}
								>
									<Plus data-icon="inline-start" />
									{label}
								</Button>
							))}
						</div>
					)}
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

			<CardContacts report={report} />
		</div>
	);
}

function describe(step) {
	switch (step.type) {
		case "email":
			return step.subject?.trim() || "No subject yet";
		case "wait":
			return `${step.amount || "…"} ${step.amount === 1 ? (step.unit ?? "").replace(/s$/, "") : (step.unit ?? "")}`.trim();
		case "add_tag":
		case "remove_tag":
			return step.tag?.trim() || "No tag yet";
		default:
			return "Contacts are done";
	}
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

function TriggerEditor({ trigger, onChange, segments, dateFields, tags, isDisabled }) {
	const listId = useId();
	const set = (changes) => onChange({ ...trigger, ...changes });

	return (
		<>
			<Select
				value={trigger.type}
				onValueChange={(type) => onChange({ type })}
				disabled={isDisabled}
			>
				<SelectTrigger className="h-9 w-full sm:w-72" aria-label="Trigger">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{Object.entries(TRIGGERS).map(([type, label]) => (
						<SelectItem key={type} value={type}>
							{label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>

			{(trigger.type === "subscribed" || trigger.type === "tag_added") && (
				<>
					<Input
						list={listId}
						value={trigger.tag ?? ""}
						onChange={(event) => set({ tag: event.target.value })}
						placeholder={trigger.type === "tag_added" ? "Tag" : "Only contacts who signed up with this tag (optional)"}
						aria-label="Tag"
						maxLength={60}
						disabled={isDisabled}
						className="h-9"
					/>
					<datalist id={listId}>
						{tags.map((tag) => (
							<option key={tag} value={tag} />
						))}
					</datalist>
				</>
			)}
			{trigger.type === "subscribed" && (
				<Input
					value={trigger.source ?? ""}
					onChange={(event) => set({ source: event.target.value })}
					placeholder="Only contacts from this source, e.g. website (optional)"
					aria-label="Source"
					maxLength={100}
					disabled={isDisabled}
					className="h-9"
				/>
			)}

			{trigger.type === "segment_joined" && (
				<>
					{segments.length === 0 ? (
						<p className="text-sm text-muted-foreground">Create a segment first.</p>
					) : (
						<Select value={trigger.segment ?? ""} onValueChange={(segment) => set({ segment })} disabled={isDisabled}>
							<SelectTrigger className="h-9 w-full sm:w-72" aria-label="Segment">
								<SelectValue placeholder="Pick a segment" />
							</SelectTrigger>
							<SelectContent>
								{segments.map((segment) => (
									<SelectItem key={segment.id} value={segment.id}>
										{segment.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					)}
					<label className="flex items-start gap-2.5 text-sm">
						<input
							type="checkbox"
							checked={Boolean(trigger.includeExisting)}
							onChange={(event) => set({ includeExisting: event.target.checked })}
							disabled={isDisabled}
							className="mt-0.5 size-4 shrink-0 accent-foreground"
						/>
						<span>
							Also start it for the contacts already in the segment
							<span className="block text-xs text-muted-foreground">Otherwise it starts for those who join after it&apos;s activated. The segment is checked about every hour.</span>
						</span>
					</label>
				</>
			)}

			{trigger.type === "date_field" && (
				<>
					{dateFields.length === 0 ? (
						<p className="text-sm text-muted-foreground">Add a date custom field first, from Tags and fields on the contacts page.</p>
					) : (
						<div className="flex flex-wrap items-center gap-2 text-sm">
							<Input
								type="number"
								min={-365}
								max={365}
								value={trigger.offsetDays ?? 0}
								onChange={(event) => set({ offsetDays: event.target.value })}
								aria-label="Days"
								disabled={isDisabled}
								className="h-9 w-20"
							/>
							days after the date in
							<Select value={trigger.field ?? ""} onValueChange={(field) => set({ field })} disabled={isDisabled}>
								<SelectTrigger className="h-9 w-44" aria-label="Date field">
									<SelectValue placeholder="Pick a field" />
								</SelectTrigger>
								<SelectContent>
									{dateFields.map((field) => (
										<SelectItem key={field.key} value={field.key}>
											{field.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<Select value={trigger.repeat ?? "once"} onValueChange={(repeat) => set({ repeat })} disabled={isDisabled}>
								<SelectTrigger className="h-9 w-36" aria-label="Repeat">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="once">Once</SelectItem>
									<SelectItem value="yearly">Every year</SelectItem>
								</SelectContent>
							</Select>
							<span className="basis-full text-xs text-muted-foreground">Negative days start it before the date.</span>
						</div>
					)}
				</>
			)}
		</>
	);
}

function StepEditor({ step, onChange, isDisabled, tags, fields }) {
	const listId = useId();
	if (step.type === "email") {
		return (
			<div>
				<div className="divide-y divide-border/60 border-b border-border/60">
					<Input
						value={step.subject ?? ""}
						onChange={(event) => onChange({ subject: event.target.value })}
						placeholder="Subject"
						aria-label="Subject"
						maxLength={200}
						disabled={isDisabled}
						className="h-11 rounded-none border-0 px-4 font-medium shadow-none focus-visible:ring-0"
					/>
					<Input
						value={step.previewText ?? ""}
						onChange={(event) => onChange({ previewText: event.target.value })}
						placeholder="Preview text"
						aria-label="Preview text"
						maxLength={300}
						disabled={isDisabled}
						className="h-11 rounded-none border-0 px-4 shadow-none focus-visible:ring-0"
					/>
				</div>
				{step.format === "html" ? (
					<textarea
						value={step.content ?? ""}
						onChange={(event) => onChange({ content: event.target.value })}
						placeholder="<html>"
						spellCheck={false}
						aria-label="Content"
						disabled={isDisabled}
						className="block min-h-72 w-full resize-none bg-transparent px-4 py-4 font-mono text-[13px] leading-6 outline-none [field-sizing:content] placeholder:text-muted-foreground"
					/>
				) : (
					<div className={cn(isDisabled && "pointer-events-none opacity-60")}>
						<EditorRich key={step._key} content={step.content ?? ""} onChange={(content) => onChange({ content })} fields={fields} />
					</div>
				)}
			</div>
		);
	}
	if (step.type === "wait") {
		return (
			<div className="flex items-center gap-2 p-4">
				<Input
					type="number"
					min={1}
					value={step.amount ?? ""}
					onChange={(event) => onChange({ amount: Number.parseInt(event.target.value, 10) || "" })}
					aria-label="Amount"
					disabled={isDisabled}
					className="h-9 w-24"
				/>
				<Select value={step.unit ?? "days"} onValueChange={(unit) => onChange({ unit })} disabled={isDisabled}>
					<SelectTrigger className="h-9 w-32" aria-label="Unit">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="minutes">minutes</SelectItem>
						<SelectItem value="hours">hours</SelectItem>
						<SelectItem value="days">days</SelectItem>
					</SelectContent>
				</Select>
			</div>
		);
	}
	if (step.type === "add_tag" || step.type === "remove_tag") {
		return (
			<div className="p-4">
				<Input
					list={listId}
					value={step.tag ?? ""}
					onChange={(event) => onChange({ tag: event.target.value })}
					placeholder="Tag"
					aria-label="Tag"
					maxLength={60}
					disabled={isDisabled}
					className="h-9"
				/>
				<datalist id={listId}>
					{tags.map((tag) => (
						<option key={tag} value={tag} />
					))}
				</datalist>
			</div>
		);
	}
	return <p className="p-4 text-sm text-muted-foreground">Contacts who reach this step are done with the automation.</p>;
}

function CardContacts({ report }) {
	const { enrollments } = report.automation;
	return (
		<aside className="h-fit rounded-xl bg-card shadow-border lg:sticky lg:top-6">
			<h2 className="flex h-12 items-center px-4 text-sm font-medium">Contacts</h2>
			<div className="border-t border-border/60 p-4">
				<dl className="grid grid-cols-3 gap-2 text-center">
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
