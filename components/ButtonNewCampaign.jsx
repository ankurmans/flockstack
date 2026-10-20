"use client";

import { useTransition } from "react";
import Link from "next/link";
import { ChevronDown, FileText, LayoutTemplate, Loader2, Plus } from "lucide-react";
import { createCampaign } from "@/app/(app)/campaigns/actions";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ADD_NEWSLETTER_PATH } from "@/lib/newsletters";
import { toast } from "@/lib/toast";

// A new draft in the open newsletter: blank, in its default style, or from one of its templates ({ id, name }).
export default function ButtonNewCampaign({ newsletterId, label = "New", size, templates = [] }) {
	const [isPending, startTransition] = useTransition();

	if (!newsletterId) {
		return (
			<Button asChild size={size}>
				<Link href={ADD_NEWSLETTER_PATH}>
					<Plus data-icon="inline-start" />
					{label}
				</Link>
			</Button>
		);
	}

	function create(templateId) {
		startTransition(async () => {
			const result = await createCampaign(newsletterId, templateId);
			if (result?.error) toast.error(result.error);
		});
	}

	const icon = isPending ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Plus data-icon="inline-start" />;

	if (templates.length === 0) {
		return (
			<Button size={size} disabled={isPending} onClick={() => create()}>
				{icon}
				{label}
			</Button>
		);
	}

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button size={size} disabled={isPending}>
					{icon}
					{label}
					<ChevronDown data-icon="inline-end" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="max-h-80 min-w-56">
				<DropdownMenuItem onSelect={() => create()}>
					<FileText />
					Blank issue
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuLabel>From a template</DropdownMenuLabel>
				{templates.map((template) => (
					<DropdownMenuItem key={template.id} onSelect={() => create(template.id)}>
						<LayoutTemplate />
						<span className="truncate">{template.name}</span>
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
