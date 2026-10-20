"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Loader2, Plus } from "lucide-react";
import { createAutomation, createAutomationFromTemplate } from "@/app/(app)/automations/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ADD_NEWSLETTER_PATH } from "@/lib/newsletters";
import { toast } from "@/lib/toast";

// The New button: a blank draft, or a draft from one of the templates, in the open newsletter. templates come from
// list_automation_templates.
export default function DialogNewAutomation({ newsletterId, templates }) {
	const [isOpen, setIsOpen] = useState(false);
	const [pending, setPending] = useState(null);
	const [isPending, startTransition] = useTransition();

	if (!newsletterId) {
		return (
			<Button asChild>
				<Link href={ADD_NEWSLETTER_PATH}>
					<Plus data-icon="inline-start" />
					New
				</Link>
			</Button>
		);
	}

	function start(key, create) {
		setPending(key);
		startTransition(async () => {
			const result = await create();
			if (result?.error) {
				toast.error(result.error);
				setPending(null);
			}
		});
	}

	return (
		<Dialog open={isOpen} onOpenChange={(open) => !isPending && setIsOpen(open)}>
			<DialogTrigger asChild>
				<Button>
					<Plus data-icon="inline-start" />
					New
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>New automation</DialogTitle>
					<DialogDescription>Start from a template, or from nothing. Either way it&apos;s a draft: nothing is sent until you activate it.</DialogDescription>
				</DialogHeader>
				<ul className="-m-1 grid max-h-[60vh] gap-2 overflow-y-auto p-1 sm:grid-cols-2">
					<Choice
						title="Start from scratch"
						text="One email to fill in, started when a contact subscribes."
						isLoading={pending === "blank"}
						isDisabled={isPending}
						onClick={() => start("blank", () => createAutomation(newsletterId))}
					/>
					{templates.map((template) => (
						<Choice
							key={template.id}
							title={template.name}
							text={template.description}
							isLoading={pending === template.id}
							isDisabled={isPending}
							onClick={() => start(template.id, () => createAutomationFromTemplate(newsletterId, template.id))}
						/>
					))}
				</ul>
			</DialogContent>
		</Dialog>
	);
}

function Choice({ title, text, onClick, isLoading, isDisabled }) {
	return (
		<li>
			<button
				type="button"
				onClick={onClick}
				disabled={isDisabled}
				className="flex h-full w-full flex-col gap-1 rounded-xl p-4 text-left shadow-border transition-colors hover:bg-muted/50 disabled:opacity-60"
			>
				<span className="flex items-center gap-2 text-sm font-medium">
					{title}
					{isLoading && <Loader2 className="size-3.5 animate-spin" />}
				</span>
				<span className="text-xs text-pretty text-muted-foreground">{text}</span>
			</button>
		</li>
	);
}
