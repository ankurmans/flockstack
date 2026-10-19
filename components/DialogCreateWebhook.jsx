"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { Loader2, Plus } from "lucide-react";
import { createWebhookEndpoint } from "@/app/(app)/webhooks/actions";
import ButtonCopy from "@/components/ButtonCopy";
import ListEventChoices from "@/components/ListEventChoices";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { submitKeepingFields } from "@/lib/submit-keeping-fields";

const ALL_NEWSLETTERS = "all";

// events: the catalog's types and titles. isFull: the plan's endpoints are all in use, so New explains instead of opening.
export default function DialogCreateWebhook({ events, newsletters, isFull, limit }) {
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
			<DialogContent className="sm:max-w-lg">
				{isFull ? (
					<>
						<DialogHeader>
							<DialogTitle>All your endpoints are in use</DialogTitle>
							<DialogDescription>
								Your plan has {limit} webhook endpoints. Delete one you don&apos;t use, or move to a bigger plan for more.
							</DialogDescription>
						</DialogHeader>
						<DialogFooter>
							<Button asChild variant="outline">
								<Link href="/billing">See plans</Link>
							</Button>
							<DialogClose asChild>
								<Button>Done</Button>
							</DialogClose>
						</DialogFooter>
					</>
				) : (
					<FormWebhookNew key={formKey} events={events} newsletters={newsletters} />
				)}
			</DialogContent>
		</Dialog>
	);
}

function FormWebhookNew({ events, newsletters }) {
	const [state, action, isPending] = useActionState(createWebhookEndpoint, null);
	const [isEveryEvent, setIsEveryEvent] = useState(true);

	if (state?.secret) {
		return (
			<>
				<DialogHeader>
					<DialogTitle>Copy the signing secret</DialogTitle>
					<DialogDescription>It is shown once. Your server uses it to check that events come from FlockStack.</DialogDescription>
				</DialogHeader>
				<div className="flex items-center gap-1 rounded-lg bg-muted py-1 pr-1 pl-3">
					<code className="min-w-0 flex-1 truncate font-mono text-[13px]">{state.secret}</code>
					<ButtonCopy value={state.secret} label="Copy secret" />
				</div>
				<DialogFooter>
					<Button asChild>
						<Link href={`/webhooks/${state.id}`}>Done</Link>
					</Button>
				</DialogFooter>
			</>
		);
	}

	return (
		<form action={action} onSubmit={submitKeepingFields(action)} className="flex flex-col gap-4">
			<DialogHeader>
				<DialogTitle>New webhook</DialogTitle>
				<DialogDescription>FlockStack POSTs each event to this address as JSON, signed with a secret only you and FlockStack know.</DialogDescription>
			</DialogHeader>
			<Input name="url" type="url" placeholder="https://example.com/flockstack-events" required autoFocus maxLength={2000} aria-label="Address" />
			<Input name="description" placeholder="What it's for, e.g. CRM sync" maxLength={200} aria-label="Description" />
			{newsletters.length > 1 && (
				<Select name="newsletter" defaultValue={ALL_NEWSLETTERS}>
					<SelectTrigger className="h-9 w-full" aria-label="Newsletter">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={ALL_NEWSLETTERS}>Every newsletter</SelectItem>
						{newsletters.map(({ id, name }) => (
							<SelectItem key={id} value={id}>
								{name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			)}
			<label className="flex items-center gap-2 text-sm">
				<Switch name="allEvents" checked={isEveryEvent} onCheckedChange={setIsEveryEvent} />
				Every event, new ones included
			</label>
			{!isEveryEvent && <ListEventChoices events={events} />}
			{state?.error && <p className="text-sm text-destructive">{state.error}</p>}
			<DialogFooter>
				<Button type="submit" disabled={isPending} className="min-w-20">
					{isPending ? <Loader2 className="animate-spin" /> : "Create"}
				</Button>
			</DialogFooter>
		</form>
	);
}
