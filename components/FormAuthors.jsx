"use client";
import { submitKeepingFields } from "@/lib/submit-keeping-fields";
import { useActionState } from "react";
import { saveAuthor } from "@/app/(app)/authors/actions";
export default function FormAuthors({ newsletter, authors }) {
	return <div className="flex flex-col gap-6"><p className="text-sm text-muted-foreground">The default writer stays in newsletter settings. Guest profiles are public. Archived guests keep their past bylines.</p>{authors.filter(({ id }) => id !== "default").map((author) => <Author key={author.id} newsletter={newsletter} author={author} />)}<Author newsletter={newsletter} /></div>;
}
function Author({ newsletter, author }) {
	const [state, action, pending] = useActionState(saveAuthor, null);
	return <form action={action} onSubmit={submitKeepingFields(action)} className="flex flex-col gap-3 rounded-xl border p-4"><input type="hidden" name="newsletter" value={newsletter} /><input type="hidden" name="id" value={author?.id ?? ""} /><h2 className="font-medium">{author ? author.name : "Add a guest author"}</h2><label className="flex flex-col gap-1 text-sm">Public name<input className="rounded-md border bg-background p-2" name="name" required maxLength={100} defaultValue={author?.name ?? ""} /></label><label className="flex flex-col gap-1 text-sm">Bio<textarea className="rounded-md border bg-background p-2" name="bio" maxLength={1000} defaultValue={author?.bio ?? ""} /></label><label className="flex flex-col gap-1 text-sm">Photo URL<input className="rounded-md border bg-background p-2" name="imageUrl" type="url" defaultValue={author?.imageUrl ?? ""} /></label><div className="flex gap-3"><button disabled={pending} className="rounded-md border px-3 py-2">Save author</button>{author && <button name="archived" value={String(!author.archived)} disabled={pending} className="rounded-md border px-3 py-2">{author.archived ? "Restore author" : "Archive author"}</button>}</div>{state?.error && <p role="alert">{state.error}</p>}{state?.ok && <p role="status">Saved.</p>}</form>;
}
