"use client";
import { useActionState } from "react";
import { saveContactLists } from "@/app/(app)/contacts/actions";
import { submitKeepingFields } from "@/lib/submit-keeping-fields";
export default function FormContactLists({ contact, lists = [] }) {
	const [state, action, pending] = useActionState(saveContactLists.bind(null, contact.id), null);
	const memberships = contact.listIds ?? [];
	if (!lists.length) return null;
	return <form action={action} onSubmit={submitKeepingFields(action)} className="flex flex-col gap-2"><h3 className="text-sm font-medium">Mailing lists</h3>{lists.filter((list) => !list.archived || memberships.includes(list.id)).map((list) => <label key={list.id} className="flex gap-2 text-sm"><input name="lists" type="checkbox" value={list.id} defaultChecked={memberships.includes(list.id)} />{list.name}{list.archived && " (archived)"}</label>)}<label className="mt-2 flex gap-2 text-xs text-muted-foreground"><input type="checkbox" name="consent" required />This contact agreed to receive emails from the selected lists.</label><p className="text-xs text-muted-foreground">This leaves their subscription status as it is.</p><button disabled={pending} className="self-start rounded-md border px-3 py-1.5 text-sm">Save list choices</button>{state?.error && <p role="alert" className="text-sm">{state.error}</p>}{state?.ok && <p role="status" className="text-sm">Saved.</p>}</form>;
}
