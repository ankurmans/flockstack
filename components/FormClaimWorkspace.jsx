"use client";
import { useActionState, useEffect, useState } from "react";
import { previewWorkspace, claimWorkspace } from "@/app/(account)/claim-workspace/actions";
import { Button } from "@/components/ui/button";
import { submitKeepingFields } from "@/lib/submit-keeping-fields";
export default function FormClaimWorkspace({ id }) {
	const [preview, setPreview] = useState(null), [token, setToken] = useState("");
	const [state, action, pending] = useActionState(claimWorkspace, null);
	useEffect(() => {
		const value = new URLSearchParams(window.location.hash.slice(1)).get("token") || "";
		Promise.resolve().then(() => setToken(value));
		let active = true;
		previewWorkspace(id, value).then((result) => { if (active) setPreview(result); });
		return () => { active = false; };
	}, [id]);
	if (state?.ok) return <p>Workspace claimed. <a href={state.reviewUrl} className="underline">Review its drafts</a>. Nothing is published or sent.</p>;
	if (!preview) return <p>Loading the draft workspace…</p>;
	if (preview.error) return <p role="alert">{preview.error}</p>;
	return <form action={action} onSubmit={submitKeepingFields(action)} className="space-y-4">
		<input type="hidden" name="id" value={id} /><input type="hidden" name="token" value={token} /><input type="hidden" name="revision" value={preview.revision} />
		<h2 className="text-lg font-semibold">{preview.name}</h2><p className="whitespace-pre-wrap text-sm">{preview.brief}</p>
		<details><summary>Review the complete brief and drafts</summary><pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(preview.payload, null, 2)}</pre></details>
		<p className="text-sm text-muted-foreground">Claiming creates a newsletter and four drafts in this account. Its archive, link page and welcome email stay off until you turn them on.</p>
		{state?.error && <p role="alert" className="text-destructive">{state.error}</p>}
		<Button disabled={pending} type="submit">{pending ? "Claiming…" : "Claim workspace"}</Button>
	</form>;
}
