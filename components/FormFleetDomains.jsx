"use client";

import { useActionState } from "react";
import { submitKeepingFields } from "@/lib/submit-keeping-fields";
import Link from "next/link";
import { onboardBrands } from "@/app/(app)/fleet/actions";
import { Button } from "@/components/ui/button";

export default function FormFleetDomains({ domains }) {
	const [state, action, pending] = useActionState(onboardBrands, null);
	return (
		<form action={action} onSubmit={submitKeepingFields(action)} className="space-y-4 rounded-xl bg-card p-5 shadow-border">
			<h2 className="font-semibold">Set up brand domains</h2>
			<p className="text-sm text-muted-foreground">Choose up to 10 domains. We add the sending and website records, keeping existing policies. Verification can take a while.</p>
			<fieldset disabled={pending} className="grid gap-2 sm:grid-cols-2">
				<legend className="sr-only">Brand domains</legend>
				{domains.map((domain) => <label key={domain} className="flex items-center gap-2 text-sm"><input type="checkbox" name="domain" value={domain} />{domain}</label>)}
			</fieldset>
			{state?.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
			{state?.domains && <ul aria-live="polite" className="space-y-2 text-sm">{state.domains.map((item) => <li key={item.domain}><strong>{item.domain}</strong>: {item.state === "ready" ? "Ready" : item.state === "pending" ? "Waiting for verification" : item.error}{item.records.length > 0 && <span className="text-muted-foreground"> · {item.records.length} DNS records checked</span>}</li>)}</ul>}
			<div className="flex items-center gap-4"><Button type="submit" disabled={pending}>{pending ? "Setting up…" : "Set up domains"}</Button><Link href="/domains" className="text-sm underline underline-offset-4">Check domains and sender addresses</Link></div>
		</form>
	);
}
