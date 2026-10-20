"use client";

import { useState, useTransition } from "react";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { deleteSnippet, saveSnippet } from "@/app/(app)/templates/actions";
import CardSettings from "@/components/CardSettings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { richToText } from "@/lib/rich-text";
import { toast } from "@/lib/toast";

const EMPTY = { id: "", name: "", content: "" };

// Pieces of content for the editor's / menu: a sign-off, a sponsor's blurb, a call to action. They are copied into the
// issue where they are inserted, so changing one leaves the issues that have it as they are.
export default function CardSnippets({ newsletterId, snippets }) {
	const [draft, setDraft] = useState(null);
	const [isPending, startTransition] = useTransition();

	function save(event) {
		event.preventDefault();
		startTransition(async () => {
			const result = await saveSnippet(newsletterId, draft.id, draft);
			if (result?.error) return void toast.error(result.error);
			setDraft(null);
		});
	}

	function remove(snippet) {
		if (!window.confirm(`Delete the snippet ${snippet.name}? Issues it was inserted into keep their copy.`)) return;
		startTransition(async () => {
			const result = await deleteSnippet(snippet.id);
			if (result?.error) toast.error(result.error);
		});
	}

	return (
		<CardSettings
			title="Snippets"
			action={
				!draft && (
					<Button type="button" size="sm" variant="outline" onClick={() => setDraft(EMPTY)}>
						<Plus data-icon="inline-start" />
						New snippet
					</Button>
				)
			}
		>
			{draft && (
				<form onSubmit={save} className="flex flex-col gap-3 px-4 py-3">
					<label className="flex flex-col gap-1.5 text-sm">
						Name
						<Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} maxLength={100} required autoFocus />
					</label>
					<label className="flex flex-col gap-1.5 text-sm">
						Content
						<Textarea value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} rows={5} maxLength={20000} required />
						<span className="text-xs text-muted-foreground">Paragraphs with a blank line between them, or HTML with links and pictures.</span>
					</label>
					<div className="flex gap-2">
						<Button type="submit" disabled={isPending}>
							{isPending && <Loader2 className="animate-spin" />}
							Save snippet
						</Button>
						<Button type="button" variant="ghost" onClick={() => setDraft(null)}>
							Cancel
						</Button>
					</div>
				</form>
			)}
			{snippets.length === 0 && !draft ? (
				<p className="px-4 py-3 text-sm text-pretty text-muted-foreground">
					No snippets yet. Write a piece you use again and again once, then press / in the editor to put it in an issue.
				</p>
			) : (
				<ul className="divide-y divide-border/60">
					{snippets.map((snippet) => (
						<li key={snippet.id} className="flex items-center gap-2 px-4 py-2.5">
							<span className="min-w-0 flex-1">
								<span className="block truncate text-sm font-medium">{snippet.name}</span>
								<span className="block truncate text-xs text-muted-foreground">{richToText(snippet.content).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ")}</span>
							</span>
							<Button
								type="button"
								size="icon-sm"
								variant="ghost"
								aria-label={`Edit ${snippet.name}`}
								onClick={() => setDraft({ id: snippet.id, name: snippet.name, content: richToText(snippet.content) })}
							>
								<Pencil />
							</Button>
							<Button type="button" size="icon-sm" variant="ghost" aria-label={`Delete ${snippet.name}`} onClick={() => remove(snippet)} disabled={isPending} className="text-muted-foreground hover:text-destructive">
								<Trash2 />
							</Button>
						</li>
					))}
				</ul>
			)}
		</CardSettings>
	);
}
