"use client";

import { useActionState } from "react";
import { refreshRevenue } from "@/app/(app)/reports/actions";
import { Button } from "@/components/ui/button";
import { submitKeepingFields } from "@/lib/submit-keeping-fields";

export default function FormRevenueRefresh({ newsletter }) {
	const [state, action, pending] = useActionState(refreshRevenue, null);
	return <form action={action} onSubmit={submitKeepingFields(action)} className="flex flex-col items-start gap-2 rounded-xl border bg-card p-4">
		<input type="hidden" name="newsletter" value={newsletter} /><input type="hidden" name="cursor" value={state?.cursor || ""} />
		<h2 className="text-sm font-medium">Refresh known subscriptions</h2>
		<p className="text-xs text-muted-foreground">Reads up to 20 known contacts&apos; subscriptions from your Stripe account and at most each latest invoice. Updates report snapshots. It does not import older history, change charges or reader access, or send email.</p>
		<Button type="submit" variant="outline" size="sm" disabled={pending}>{pending ? "Reading Stripe…" : state?.cursor ? "Continue with the next 20 contacts" : "Refresh the first 20 contacts"}</Button>
		{state?.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
		{state?.ok && <p role="status" className="text-xs text-muted-foreground">{state.contactsScanned} contacts and {state.groupsScanned ?? 0} groups scanned; {state.subscriptionsObserved} subscriptions observed; {state.invoicesRecorded} latest invoices recorded; {state.skipped} skipped reads. {state.cursor ? "More known subscriptions remain." : "Reached the end of known individual and group subscriptions. This does not establish complete Stripe history."}</p>}
	</form>;
}
