"use client";

import { useState, useTransition } from "react";
import { Check, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { createCampaign } from "@/app/(app)/campaigns/actions";
import { deleteTemplate, renameTemplate } from "@/app/(app)/templates/actions";
import CardSettings from "@/components/CardSettings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/lib/toast";

// The newsletter's saved issues. Any issue becomes one from its menu, Save as template; a new issue starts from one in
// the New menu of Campaigns, or here.
export default function CardTemplates({ newsletterId, templates }) {
	const [editing, setEditing] = useState(null);
	const [name, setName] = useState("");
	const [isPending, startTransition] = useTransition();

	function rename(event) {
		event.preventDefault();
		startTransition(async () => {
			const result = await renameTemplate(editing, name);
			if (result?.error) return void toast.error(result.error);
			setEditing(null);
		});
	}

	function remove(template) {
		if (!window.confirm(`Delete the template ${template.name}? Issues started from it stay as they are.`)) return;
		startTransition(async () => {
			const result = await deleteTemplate(template.id);
			if (result?.error) toast.error(result.error);
		});
	}

	function start(template) {
		startTransition(async () => {
			const result = await createCampaign(newsletterId, template.id);
			if (result?.error) toast.error(result.error);
		});
	}

	return (
		<CardSettings title="Issue templates">
			{templates.length === 0 ? (
				<p className="px-4 py-3 text-sm text-pretty text-muted-foreground">
					No templates yet. Open any issue, draft or sent, and choose Save as template from its menu: new issues can start from it, with its
					subject, preview text and content.
				</p>
			) : (
				<ul className="divide-y divide-border/60">
					{templates.map((template) => (
						<li key={template.id} className="flex items-center gap-2 px-4 py-2.5">
							{editing === template.id ? (
								<form onSubmit={rename} className="flex min-w-0 flex-1 items-center gap-2">
									<Input value={name} onChange={(event) => setName(event.target.value)} maxLength={100} required autoFocus aria-label="Template name" />
									<Button type="submit" size="icon-sm" variant="ghost" aria-label="Save the name" disabled={isPending}>
										<Check />
									</Button>
									<Button type="button" size="icon-sm" variant="ghost" aria-label="Cancel" onClick={() => setEditing(null)}>
										<X />
									</Button>
								</form>
							) : (
								<>
									<span className="min-w-0 flex-1">
										<span className="block truncate text-sm font-medium">{template.name}</span>
										<span className="block truncate text-xs text-muted-foreground">{template.subject || "No subject"}</span>
									</span>
									<Button type="button" size="sm" variant="outline" onClick={() => start(template)} disabled={isPending}>
										{isPending ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Plus data-icon="inline-start" />}
										New issue
									</Button>
									<Button
										type="button"
										size="icon-sm"
										variant="ghost"
										aria-label={`Rename ${template.name}`}
										onClick={() => {
											setEditing(template.id);
											setName(template.name);
										}}
									>
										<Pencil />
									</Button>
									<Button type="button" size="icon-sm" variant="ghost" aria-label={`Delete ${template.name}`} onClick={() => remove(template)} className="text-muted-foreground hover:text-destructive">
										<Trash2 />
									</Button>
								</>
							)}
						</li>
					))}
				</ul>
			)}
		</CardSettings>
	);
}
