"use client";

import { useActionState } from "react";
import { saveCreatorSettings } from "@/app/(app)/recommending/creators/actions";
import { submitKeepingFields } from "@/lib/submit-keeping-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function FormCreatorProfile({ newsletter, profile }) {
	const [state, action, pending] = useActionState(saveCreatorSettings, null);
	return <form action={action} onSubmit={submitKeepingFields(action)} className="flex flex-col gap-4 rounded-xl border bg-card p-4">
		<h2 className="font-medium">Creator profile</h2>
		<input type="hidden" name="newsletter" value={newsletter} />
		<label className="flex items-center gap-2 text-sm"><input type="checkbox" name="enabled" defaultChecked={profile.enabled} />Show me to other creators and accept introductions</label>
		<p className="text-sm text-muted-foreground">Your recommendation listing, topics and subscriber range are shared with opted-in creators in this region. List your newsletter in recommendations first. Switching matching off stops new introductions; close existing conversations to stop their replies.</p>
		<label className="flex flex-col gap-2 text-sm">Topics, separated by commas<Input name="topics" defaultValue={profile.topics.join(", ")} maxLength={310} placeholder="gardening, food" /></label>
		<label className="flex items-center gap-2 text-sm"><input type="checkbox" name="emailNotifications" defaultChecked={profile.emailNotifications} />Email the account owner about private messages</label>
		<p className="text-xs text-muted-foreground">At most one notification per conversation per hour. Your account address is kept private. Messages remain available in the inbox.</p>
		{state?.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
		{state?.ok && <p role="status" className="text-sm">Saved.</p>}
		<Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save profile"}</Button>
	</form>;
}
