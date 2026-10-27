"use client";
import { submitKeepingFields } from "@/lib/submit-keeping-fields";
import { useActionState } from "react";
import { chooseIssueAuthor } from "@/app/(app)/authors/actions";
export default function FormIssueAuthor({ campaign, authors, selected = "default" }) {
	const [state, action, pending] = useActionState(chooseIssueAuthor, null);
	return <form action={action} onSubmit={submitKeepingFields(action)} className="flex flex-col gap-3 rounded-xl border p-4"><input type="hidden" name="campaign" value={campaign} /><label className="flex flex-col gap-2 text-sm">Issue author<select name="author" defaultValue={selected} className="rounded-md border bg-background p-2">{authors.filter((author) => !author.archived || author.id === selected).map((author) => <option key={author.id} value={author.id}>{author.name}{author.archived ? " (archived)" : ""}</option>)}</select></label><p className="text-xs text-muted-foreground">Changes the public byline. Sent emails and sender names stay as they were.</p><button className="rounded-md border px-3 py-2" disabled={pending}>Save byline</button>{state?.error && <p role="alert">{state.error}</p>}{state?.ok && <p role="status">Saved.</p>}</form>;
}
