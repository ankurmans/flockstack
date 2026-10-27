"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { changeCreatorConversation, sendCreatorReply, sendIntroduction } from "@/app/(app)/recommending/creators/actions";
import { submitKeepingFields } from "@/lib/submit-keeping-fields";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export default function FormCreatorMessage({ newsletter, to, conversation }) {
	const [state, action, pending] = useActionState(conversation ? sendCreatorReply : sendIntroduction, null);
	const [externalId, setExternalId] = useState("");
	return <form action={action} onSubmit={submitKeepingFields(action)} className="flex flex-col gap-3">
		<input type="hidden" name="newsletter" value={newsletter || ""} /><input type="hidden" name="to" value={to || ""} /><input type="hidden" name="id" value={conversation || ""} />
		<input type="hidden" name="externalId" value={externalId} />
		<label className="flex flex-col gap-2 text-sm">{conversation ? "Reply" : "Introduce yourself"}<Textarea name="body" required maxLength={2000} disabled={pending || state?.ok} onFocus={() => { if (!externalId) setExternalId(crypto.randomUUID()); }} /></label>
		<p className="text-xs text-muted-foreground">These words go to the other creator&apos;s private inbox and may be emailed to them. Each account keeps a copy. FlockStack does not share your account address; include contact details only if you want to share them.</p>
		{state?.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
		{state?.ok ? <p role="status" className="text-sm">Saved in both inboxes. <Link className="underline" href={`/recommending/creators/${state.output.conversationId}`}>Open conversation</Link><Button type="button" variant="link" onClick={() => window.location.reload()}>Write another</Button></p> : <Button type="submit" disabled={pending || !externalId}>{pending ? "Sending…" : conversation ? "Send reply" : "Send introduction"}</Button>}
	</form>;
}

export function FormCreatorConversation({ id, closed }) {
	const [state, action, pending] = useActionState(changeCreatorConversation, null);
	return <form action={action} onSubmit={submitKeepingFields(action)} className="flex flex-col items-start gap-2">
		<input type="hidden" name="id" value={id} /><input type="hidden" name="closed" value={String(!closed)} />
		<Button type="submit" variant="outline" disabled={pending}>{closed ? "Reopen your side" : "Close conversation"}</Button>
		{state?.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
	</form>;
}
