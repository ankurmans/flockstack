"use client";

import { ArrowDown, ArrowUp, Clock, GitBranch, Mail, PenLine, Plus, Shuffle, Square, Tag, Trash2, Webhook, ArrowRightLeft } from "lucide-react";
import TableAutomationVariants from "@/components/TableAutomationVariants";
import EditorStep from "@/components/EditorStep";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { MAX_NESTING, addStep, canMoveStep, hasEndingStep, moveStep, newStep, removeStep, updatePath, updateStep } from "@/lib/automation-editor";
import { formatNumber } from "@/lib/format";

const STEP_ICONS = { email: Mail, wait: Clock, add_tag: Tag, remove_tag: Tag, set_field: PenLine, webhook: Webhook, branch: GitBranch, split: Shuffle, move: ArrowRightLeft, end: Square };
export const STEP_NAMES = {
	email: "Send an email",
	wait: "Wait",
	add_tag: "Add a tag",
	remove_tag: "Remove a tag",
	set_field: "Set a field",
	webhook: "Send a webhook",
	branch: "Branch on a condition",
	split: "Split at random",
	move: "Move to another automation",
	end: "End",
};
const BRANCHING = ["branch", "split"];

const capitalize = (word) => word[0].toUpperCase() + word.slice(1);

function describe(step, fields, segments, automations) {
	switch (step.type) {
		case "email":
			return step.subject?.trim() || "No subject yet";
		case "wait":
			if (step.waitMode === "until") return step.until ? `Until ${step.until.replace("T", " ")} UTC` : "Until a date";
			if (step.waitMode === "weekday") return `Until ${capitalize(step.weekday ?? "monday")} at ${step.time || "09:00"}${step.timeZone && step.timeZone !== "UTC" ? ` (${step.timeZone})` : ""}`;
			return `${step.amount || "…"} ${step.amount === 1 ? (step.unit ?? "").replace(/s$/, "") : (step.unit ?? "")}`.trim();
		case "add_tag":
		case "remove_tag":
			return step.tag?.trim() || "No tag yet";
		case "set_field": {
			const label = fields.find(({ key }) => key === step.field)?.label ?? step.field;
			if (!label) return "No field yet";
			return step.isClearing ? `Clear ${label}` : `Set ${label} to ${Array.isArray(step.value) ? step.value.join(", ") : String(step.value ?? "") || "…"}`;
		}
		case "webhook":
			return step.name?.trim() || "automation.step event";
		case "branch":
			return step.mode === "segment" ? `In the segment ${segments.find(({ id }) => id === step.segment)?.name ?? "…"}?` : "Matches the conditions?";
		case "split":
			return step.paths.map((path) => `${path.percent}%`).join(" / ");
		case "move":
			return automations.find(({ id }) => id === step.automation)?.name ?? "Pick an automation";
		default:
			return "Contacts are done";
	}
}

function pathTitle(step, path, index) {
	if (step.type === "branch") return index === 0 ? "Contacts who match" : "Everyone else";
	return path.name?.trim() || `Path ${index + 1}`;
}

// A list of steps, and under a branch or a split the lists of its paths, indented: the automation's tree. ctx holds what the
// whole tree shares (FormAutomation): the steps and how to change them, the open step, the newsletter's choices and the
// report's numbers.
export default function ListSteps({ steps, list = null, level = 1, ctx }) {
	const { allSteps, setAllSteps, isDisabled, openKey, setOpenKey, reportByStep, choices, segments, automations } = ctx;
	const change = (next) => setAllSteps(next);
	const canBranch = level < MAX_NESTING;

	function add(type) {
		const step = newStep(type);
		change(addStep(allSteps, list, step));
		setOpenKey(step._key);
	}

	return (
		<div className="flex flex-col gap-3">
			{steps.map((step) => {
				const Icon = STEP_ICONS[step.type] ?? Square;
				const isOpen = openKey === step._key;
				const stats = reportByStep.get(step.id);
				const isBranching = BRANCHING.includes(step.type);
				return (
					<div key={step._key} className="flex flex-col gap-3">
						<div className="rounded-xl bg-card shadow-border animate-enter">
							<div className="flex items-center gap-3 px-4 py-3">
								<span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
									<Icon className="size-4" aria-hidden="true" />
								</span>
								<button type="button" onClick={() => setOpenKey(isOpen ? null : step._key)} aria-expanded={isOpen} className="min-w-0 flex-1 text-left">
									<span className="block truncate text-sm font-medium">{describe(step, choices.fields, segments, automations)}</span>
									<span className="block truncate text-xs text-muted-foreground">
										{STEP_NAMES[step.type]}
										{stats?.ran > 0 ? ` · ran for ${formatNumber(stats.ran)}` : ""}
										{stats?.waiting > 0 ? ` · ${formatNumber(stats.waiting)} waiting for it` : ""}
										{stats?.sent ? ` · ${formatNumber(stats.sent)} sent, ${formatNumber(stats.opened ?? 0)} opened` : ""}
									</span>
								</button>
								{!isDisabled && (
									<span className="flex shrink-0 items-center">
										<Button variant="ghost" size="icon-sm" onClick={() => change(moveStep(allSteps, step._key, -1))} disabled={!canMoveStep(allSteps, step._key, -1)} aria-label="Move up">
											<ArrowUp />
										</Button>
										<Button variant="ghost" size="icon-sm" onClick={() => change(moveStep(allSteps, step._key, 1))} disabled={!canMoveStep(allSteps, step._key, 1)} aria-label="Move down">
											<ArrowDown />
										</Button>
										<Button
											variant="ghost"
											size="icon-sm"
											onClick={() => change(removeStep(allSteps, step._key))}
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
									<EditorStep
										step={step}
										onChange={(changes) => change(updateStep(allSteps, step._key, changes))}
										isDisabled={isDisabled}
										choices={choices}
										segments={segments}
										automations={automations}
									/>
									{stats?.variants?.length > 0 && <TableAutomationVariants variants={stats.variants} />}
								</div>
							)}
						</div>

						{isBranching &&
							step.paths.map((path, index) => (
								<div key={path._key} className="ml-4 flex flex-col gap-3 border-l-2 border-border/70 pl-4 sm:ml-6 sm:pl-5">
									<div className="flex flex-wrap items-center gap-2 text-sm">
										{step.type === "split" ? (
											<>
												<Input
													type="number"
													min={1}
													max={99}
													value={path.percent ?? ""}
													onChange={(event) => change(updatePath(allSteps, step._key, path._key, { percent: event.target.value }))}
													aria-label={`Share of path ${index + 1}`}
													disabled={isDisabled}
													className="h-8 w-20"
												/>
												%
												<Input
													value={path.name ?? ""}
													onChange={(event) => change(updatePath(allSteps, step._key, path._key, { name: event.target.value }))}
													placeholder={`Path ${index + 1}`}
													aria-label={`Name of path ${index + 1}`}
													maxLength={60}
													disabled={isDisabled}
													className="h-8 w-40"
												/>
											</>
										) : (
											<span className="font-medium">{pathTitle(step, path, index)}</span>
										)}
										{stats?.pathRuns && <span className="text-xs text-muted-foreground">{formatNumber(stats.pathRuns[index] ?? 0)} contacts took it</span>}
									</div>
									<ListSteps steps={path.steps} list={{ stepKey: step._key, pathKey: path._key }} level={level + 1} ctx={ctx} />
								</div>
							))}
					</div>
				);
			})}

			{!isDisabled &&
				(hasEndingStep(steps) ? (
					<p className="text-xs text-muted-foreground">A {steps.at(-1).type} ends this list: add the steps that follow it to its paths.</p>
				) : (
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button variant="outline" size="sm" className="self-start">
								<Plus data-icon="inline-start" />
								Add a step
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start" className="min-w-52">
							{Object.entries(STEP_NAMES)
								.filter(([type]) => canBranch || !BRANCHING.includes(type))
								.map(([type, label]) => {
									const Icon = STEP_ICONS[type];
									return (
										<DropdownMenuItem key={type} onSelect={() => add(type)}>
											<Icon />
											{label}
										</DropdownMenuItem>
									);
								})}
						</DropdownMenuContent>
					</DropdownMenu>
				))}
		</div>
	);
}
