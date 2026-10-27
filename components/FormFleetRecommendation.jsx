"use client";

import { useActionState } from "react";
import { submitKeepingFields } from "@/lib/submit-keeping-fields";
import { recommendBrand } from "@/app/(app)/fleet/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function FormFleetRecommendation({ newsletters }) {
	const [state, action, pending] = useActionState(recommendBrand, null);
	return (
		<form action={action} onSubmit={submitKeepingFields(action)} className="space-y-4 rounded-xl bg-card p-5 shadow-border">
			<h2 className="font-semibold">Recommend another brand</h2>
			<p className="text-sm text-muted-foreground">Readers choose whether to subscribe. Their address stays with each list they join.</p>
			<div className="grid gap-4 sm:grid-cols-2">
				<label className="space-y-2 text-sm"><span>Recommend from</span><select name="newsletter" required disabled={pending} className="h-10 w-full rounded-md border border-input bg-background px-3">{newsletters.map((item) => <option key={item.id} value={item.slug}>{item.name}</option>)}</select></label>
				<label className="space-y-2 text-sm"><span>Recommend this newsletter</span><select name="slug" required disabled={pending} defaultValue={newsletters[1]?.slug} className="h-10 w-full rounded-md border border-input bg-background px-3">{newsletters.map((item) => <option key={item.id} value={item.slug}>{item.name}</option>)}</select></label>
			</div>
			<label className="block space-y-2 text-sm"><span>Why readers might like it</span><Input name="pitch" required maxLength={160} disabled={pending} /></label>
			{state?.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
			{state?.ok && <p role="status" className="text-sm">Recommendation added. Manage it on the Recommendations page.</p>}
			<Button type="submit" disabled={pending}>{pending ? "Adding…" : "Add recommendation"}</Button>
		</form>
	);
}
