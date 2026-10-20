"use client";

import { useId } from "react";
import EditorRich from "@/components/EditorRich";
import EditorRules from "@/components/EditorRules";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MAX_SPLIT_PATHS, evenPercents, newKey } from "@/lib/automation-editor";
import { cn } from "@/lib/utils";

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const COMMON_ZONES = ["UTC", "America/New_York", "America/Chicago", "America/Los_Angeles", "Europe/London", "Europe/Paris", "Europe/Berlin", "Asia/Kolkata", "Asia/Tokyo", "Australia/Sydney"];

// The settings of one step, under its card. choices, segments and automations are the newsletter's; isDisabled while the
// automation is active.
export default function EditorStep({ step, onChange, isDisabled, choices, segments, automations }) {
	const listId = useId();
	if (step.type === "email") return <EmailSettings step={step} onChange={onChange} isDisabled={isDisabled} fields={choices.fields} />;
	if (step.type === "wait") return <WaitSettings step={step} onChange={onChange} isDisabled={isDisabled} />;

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
					{choices.tags.map((tag) => (
						<option key={tag} value={tag} />
					))}
				</datalist>
			</div>
		);
	}

	if (step.type === "set_field") return <FieldSettings step={step} onChange={onChange} isDisabled={isDisabled} fields={choices.fields} />;

	if (step.type === "webhook") {
		return (
			<div className="flex flex-col gap-3 p-4">
				<Input
					value={step.name ?? ""}
					onChange={(event) => onChange({ name: event.target.value })}
					placeholder="A name for your endpoint to tell it by, e.g. add-to-crm"
					aria-label="Name"
					maxLength={60}
					disabled={isDisabled}
					className="h-9"
				/>
				<p className="text-xs text-pretty text-muted-foreground">
					Sends an <code className="rounded bg-muted px-1 py-0.5 font-mono">automation.step</code> event with the contact to your webhook endpoints that take it, signed like the
					others. Add one on the Webhooks page.
				</p>
			</div>
		);
	}

	if (step.type === "branch") return <BranchSettings step={step} onChange={onChange} isDisabled={isDisabled} choices={choices} segments={segments} />;
	if (step.type === "split") return <SplitSettings step={step} onChange={onChange} isDisabled={isDisabled} />;

	if (step.type === "move") {
		return (
			<div className="flex flex-col gap-3 p-4">
				{automations.length === 0 ? (
					<p className="text-sm text-muted-foreground">There is no other automation in this newsletter to move contacts to.</p>
				) : (
					<Select value={step.automation ?? ""} onValueChange={(automation) => onChange({ automation })} disabled={isDisabled}>
						<SelectTrigger className="h-9 w-full sm:w-72" aria-label="Automation">
							<SelectValue placeholder="Pick an automation" />
						</SelectTrigger>
						<SelectContent>
							{automations.map((automation) => (
								<SelectItem key={automation.id} value={automation.id}>
									{automation.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				)}
				<p className="text-xs text-pretty text-muted-foreground">The contact starts that automation from its first step and is done with this one. A contact enters an automation once.</p>
			</div>
		);
	}

	return <p className="p-4 text-sm text-muted-foreground">Contacts who reach this step are done with the automation.</p>;
}

function EmailSettings({ step, onChange, isDisabled, fields }) {
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

function WaitSettings({ step, onChange, isDisabled }) {
	const mode = step.waitMode ?? "duration";
	return (
		<div className="flex flex-col gap-3 p-4">
			<Select value={mode} onValueChange={(waitMode) => onChange({ waitMode })} disabled={isDisabled}>
				<SelectTrigger className="h-9 w-full sm:w-72" aria-label="Wait for">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="duration">A length of time</SelectItem>
					<SelectItem value="until">Until a date and time</SelectItem>
					<SelectItem value="weekday">Until a day of the week</SelectItem>
				</SelectContent>
			</Select>
			{mode === "duration" && (
				<div className="flex items-center gap-2">
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
			)}
			{mode === "until" && (
				<div className="flex flex-wrap items-center gap-2 text-sm">
					<Input type="datetime-local" value={step.until ?? ""} onChange={(event) => onChange({ until: event.target.value })} aria-label="Date and time" disabled={isDisabled} className="h-9 w-56" />
					UTC
					<span className="basis-full text-xs text-muted-foreground">A date that has passed doesn&apos;t make contacts wait.</span>
				</div>
			)}
			{mode === "weekday" && (
				<div className="flex flex-wrap items-center gap-2 text-sm">
					<Select value={step.weekday ?? "monday"} onValueChange={(weekday) => onChange({ weekday })} disabled={isDisabled}>
						<SelectTrigger className="h-9 w-36" aria-label="Day of the week">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{WEEKDAYS.map((day) => (
								<SelectItem key={day} value={day}>
									{day[0].toUpperCase() + day.slice(1)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					at
					<Input type="time" value={step.time ?? "09:00"} onChange={(event) => onChange({ time: event.target.value })} aria-label="Time" disabled={isDisabled} className="h-9 w-28" />
					<Select value={step.timeZone ?? "UTC"} onValueChange={(timeZone) => onChange({ timeZone })} disabled={isDisabled}>
						<SelectTrigger className="h-9 w-48" aria-label="Time zone">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{[...new Set([step.timeZone ?? "UTC", ...COMMON_ZONES])].map((zone) => (
								<SelectItem key={zone} value={zone}>
									{zone}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<span className="basis-full text-xs text-muted-foreground">The next time it is that day and hour, today if it hasn&apos;t passed.</span>
				</div>
			)}
		</div>
	);
}

function FieldSettings({ step, onChange, isDisabled, fields }) {
	const field = fields.find(({ key }) => key === step.field);
	return (
		<div className="flex flex-col gap-3 p-4">
			{fields.length === 0 ? (
				<p className="text-sm text-muted-foreground">Add a custom field first, from Tags and fields on the contacts page.</p>
			) : (
				<div className="flex flex-wrap items-center gap-2 text-sm">
					<Select value={step.field ?? ""} onValueChange={(key) => onChange({ field: key, value: "", isClearing: false })} disabled={isDisabled}>
						<SelectTrigger className="h-9 w-44" aria-label="Custom field">
							<SelectValue placeholder="Pick a field" />
						</SelectTrigger>
						<SelectContent>
							{fields.map(({ key, label }) => (
								<SelectItem key={key} value={key}>
									{label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					to
					{step.isClearing ? (
						<span className="text-muted-foreground">nothing</span>
					) : field?.type === "boolean" ? (
						<Select value={String(step.value)} onValueChange={(value) => onChange({ value })} disabled={isDisabled}>
							<SelectTrigger className="h-9 w-28" aria-label="Value">
								<SelectValue placeholder="Pick one" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="true">true</SelectItem>
								<SelectItem value="false">false</SelectItem>
							</SelectContent>
						</Select>
					) : field?.type === "list" && !field.multiple ? (
						<Select value={String(step.value ?? "")} onValueChange={(value) => onChange({ value })} disabled={isDisabled}>
							<SelectTrigger className="h-9 w-40" aria-label="Value">
								<SelectValue placeholder="Pick one" />
							</SelectTrigger>
							<SelectContent>
								{field.options.map((option) => (
									<SelectItem key={option} value={option}>
										{option}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					) : (
						<Input
							type={field?.type === "number" ? "number" : field?.type === "date" ? "date" : field?.type === "datetime" ? "datetime-local" : "text"}
							step={field?.type === "number" ? "any" : undefined}
							value={Array.isArray(step.value) ? step.value.join(", ") : String(step.value ?? "")}
							onChange={(event) => onChange({ value: event.target.value })}
							placeholder={field?.type === "list" ? field.options.join(", ") : "Value"}
							aria-label="Value"
							disabled={isDisabled}
							className="h-9 w-48"
						/>
					)}
				</div>
			)}
			<label className="flex items-center gap-2.5 text-sm">
				<input
					type="checkbox"
					checked={Boolean(step.isClearing)}
					onChange={(event) => onChange({ isClearing: event.target.checked })}
					disabled={isDisabled}
					className="size-4 shrink-0 accent-foreground"
				/>
				Clear the field instead
			</label>
		</div>
	);
}

function BranchSettings({ step, onChange, isDisabled, choices, segments }) {
	return (
		<div className="flex flex-col gap-3 p-4">
			<Select value={step.mode ?? "condition"} onValueChange={(mode) => onChange({ mode })} disabled={isDisabled}>
				<SelectTrigger className="h-9 w-full sm:w-72" aria-label="Check">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="condition">Check these conditions</SelectItem>
					<SelectItem value="segment" disabled={segments.length === 0}>
						Check a saved segment
					</SelectItem>
				</SelectContent>
			</Select>
			{step.mode === "segment" ? (
				<Select value={step.segment ?? ""} onValueChange={(segment) => onChange({ segment })} disabled={isDisabled}>
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
			) : (
				<fieldset disabled={isDisabled} className={cn(isDisabled && "pointer-events-none opacity-60")}>
					<EditorRules state={step.rulesState} onChange={(rulesState) => onChange({ rulesState })} {...choices} />
				</fieldset>
			)}
			<p className="text-xs text-pretty text-muted-foreground">
				Contacts are checked when they reach this step, so the answer includes what the steps before it did. The first path is for contacts who match, the second for the rest.
			</p>
		</div>
	);
}

function SplitSettings({ step, onChange, isDisabled }) {
	const total = step.paths.reduce((sum, path) => sum + (Number(path.percent) || 0), 0);
	const withPercents = (paths) => {
		const shares = evenPercents(paths.length);
		return paths.map((path, index) => ({ ...path, percent: shares[index] }));
	};

	return (
		<div className="flex flex-col gap-3 p-4">
			<div className="flex flex-wrap items-center gap-2">
				<Button type="button" variant="outline" size="sm" disabled={isDisabled || step.paths.length >= MAX_SPLIT_PATHS} onClick={() => onChange({ paths: withPercents([...step.paths, { _key: newKey(), steps: [] }]) })}>
					Add a path
				</Button>
				<Button type="button" variant="outline" size="sm" disabled={isDisabled || step.paths.length <= 2} onClick={() => onChange({ paths: withPercents(step.paths.slice(0, -1)) })}>
					Remove the last path
				</Button>
				<Button type="button" variant="outline" size="sm" disabled={isDisabled} onClick={() => onChange({ paths: withPercents(step.paths) })}>
					Divide evenly
				</Button>
			</div>
			<p className={cn("text-sm", total === 100 ? "text-muted-foreground" : "text-destructive")}>
				{total === 100 ? "The shares add up to 100%." : `The shares add up to ${total}%: they have to add up to 100%.`}
			</p>
			<Input
				value={step.seed ?? ""}
				onChange={(event) => onChange({ seed: event.target.value })}
				placeholder="Seed (optional)"
				aria-label="Seed"
				maxLength={60}
				disabled={isDisabled}
				className="h-9 sm:w-72"
			/>
			<p className="text-xs text-pretty text-muted-foreground">
				Each contact lands on the same path every time, spread by a hash of this seed and the contact. Give two splits the same seed to keep the same contacts together.
			</p>
		</div>
	);
}
