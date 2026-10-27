"use client";
import { useActionState } from "react";
import { saveMailingList } from "@/app/(app)/mailing-lists/actions";
import { submitKeepingFields } from "@/lib/submit-keeping-fields";
export default function FormMailingLists({ newsletter, lists }) {
	return <div className="flex flex-col gap-5"><p className="text-sm text-muted-foreground">Readers choose these lists in their preferences. Select lists in an issue&apos;s send step to target their members. General issues still go to all active subscribers.</p>{lists.map((list) => <ListForm key={list.id} newsletter={newsletter} list={list} />)}<ListForm newsletter={newsletter} /></div>;
}
function ListForm({ newsletter, list }) {
	const [state, action, pending] = useActionState(saveMailingList, null);
	return <form action={action} onSubmit={submitKeepingFields(action)} className="flex flex-col gap-3 rounded-xl border p-4"><h2 className="font-medium">{list?.name ?? "Add a list"}</h2><input name="newsletter" type="hidden" value={newsletter} /><input name="id" type="hidden" value={list?.id ?? ""} /><label className="flex flex-col gap-1 text-sm">Name<input className="rounded-md border bg-background p-2" name="name" required maxLength={80} defaultValue={list?.name ?? ""} /></label><label className="flex flex-col gap-1 text-sm">Description<textarea name="description" maxLength={300} className="rounded-md border bg-background p-2" defaultValue={list?.description ?? ""} /></label><label className="flex gap-2 text-sm"><input type="checkbox" name="archived" defaultChecked={list?.archived ?? false} />Archive this list</label><p className="text-xs text-muted-foreground">Archiving keeps existing members and campaign audiences. It hides the list from new choices.</p><button disabled={pending} className="rounded-md border px-3 py-2">Save list</button>{list && <p className="text-xs text-muted-foreground">List ID: <code>{list.id}</code></p>}{state?.error && <p role="alert">{state.error}</p>}{state?.ok && <p role="status">Saved.</p>}</form>;
}
