"use client";

import { useActionState, useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { createApiKey } from "@/app/(app)/api-keys/actions";
import ButtonCopy from "@/components/ButtonCopy";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { PRESET_INFO } from "@/lib/action-scopes";
import { submitKeepingFields } from "@/lib/submit-keeping-fields";

// newsletters: [{ id, name }], for limiting a key to one.
export default function DialogCreateApiKey({ newsletters = [] }) {
	const [isOpen, setIsOpen] = useState(false);
	const [formKey, setFormKey] = useState(0);

	return (
		<Dialog
			open={isOpen}
			onOpenChange={(open) => {
				setIsOpen(open);
				if (!open) setFormKey((key) => key + 1);
			}}
		>
			<DialogTrigger asChild>
				<Button>
					<Plus data-icon="inline-start" />
					New
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<FormApiKey key={formKey} newsletters={newsletters} />
			</DialogContent>
		</Dialog>
	);
}

export function FormApiKey({ newsletters }) {
	const [state, action, isPending] = useActionState(createApiKey, null);

	if (state?.key) {
		return (
			<>
				<DialogHeader>
					<DialogTitle>Copy your key</DialogTitle>
					<DialogDescription>
						{state.level === "signups"
							? "It is shown once. It can only add contacts, so it can go in your website's code."
							: `It is shown once. Keep it on a server or in your AI assistant's settings, never in a web page. ${PRESET_INFO[state.level]?.label ?? ""} access: ${PRESET_INFO[state.level]?.can ?? ""}`}
					</DialogDescription>
				</DialogHeader>
				<div className="flex items-center gap-1 rounded-lg bg-muted py-1 pr-1 pl-3">
					<code className="min-w-0 flex-1 truncate font-mono text-[13px]">{state.key}</code>
					<ButtonCopy value={state.key} label="Copy key" />
				</div>
				<DialogFooter>
					<DialogClose asChild>
						<Button>Done</Button>
					</DialogClose>
				</DialogFooter>
			</>
		);
	}

	return (
		<form action={action} onSubmit={submitKeepingFields(action)} className="flex flex-col gap-4">
			<DialogHeader>
				<DialogTitle>New API key</DialogTitle>
				<DialogDescription>For the REST API and the MCP server.</DialogDescription>
			</DialogHeader>
			<Input name="name" placeholder="Name, e.g. Website signups" required autoFocus maxLength={60} />
			<fieldset className="grid gap-2">
				<legend className="sr-only">Access</legend>
				{LEVELS.map((value) => (
					<label
						key={value}
						className="flex items-start gap-3 rounded-lg p-3 shadow-border transition-[box-shadow,background-color] duration-150 hover:shadow-border-hover has-checked:bg-muted/60 has-checked:shadow-border-hover"
					>
						<input
							type="radio"
							name="level"
							value={value}
							defaultChecked={value === DEFAULT_LEVEL}
							className="mt-0.5 size-4 shrink-0 accent-foreground"
						/>
						<span className="flex flex-col gap-0.5">
							<span className="text-sm font-medium">
								{PRESET_INFO[value].label}
								{value === DEFAULT_LEVEL && <span className="ml-2 text-xs font-normal text-muted-foreground">Recommended for agents</span>}
							</span>
							<span className="text-xs text-pretty text-muted-foreground">{PRESET_INFO[value].description}</span>
						</span>
					</label>
				))}
			</fieldset>
			<div className="grid gap-3 sm:grid-cols-3">
				<label className="flex flex-col gap-1 text-xs text-muted-foreground">
					Newsletter
					<select name="newsletter" defaultValue="" className="h-9 rounded-lg bg-background px-2 text-sm text-foreground shadow-border">
						<option value="">All newsletters</option>
						{newsletters.map(({ id, name }) => (
							<option key={id} value={id}>
								{name}
							</option>
						))}
					</select>
				</label>
				<label className="flex flex-col gap-1 text-xs text-muted-foreground">
					Expires
					<select name="expiresInDays" defaultValue="" className="h-9 rounded-lg bg-background px-2 text-sm text-foreground shadow-border">
						<option value="">Never</option>
						<option value="7">In 7 days</option>
						<option value="30">In 30 days</option>
						<option value="90">In 90 days</option>
						<option value="365">In a year</option>
					</select>
				</label>
				<label className="flex flex-col gap-1 text-xs text-muted-foreground">
					Calls a day
					<Input name="dailyCap" type="number" min={1} max={1000000} placeholder="No cap" className="h-9" />
				</label>
			</div>
			{state?.error && <p className="text-sm text-destructive">{state.error}</p>}
			<DialogFooter>
				<Button type="submit" disabled={isPending} className="min-w-20">
					{isPending ? <Loader2 className="animate-spin" /> : "Create"}
				</Button>
			</DialogFooter>
		</form>
	);
}

const LEVELS = ["read_only", "drafts", "send_with_approval", "full", "signups"];
const DEFAULT_LEVEL = "send_with_approval";
