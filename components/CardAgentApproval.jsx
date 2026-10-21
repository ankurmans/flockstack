"use client";

import { useState, useTransition } from "react";
import { setAgentApproval } from "@/app/(app)/approvals/actions";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/lib/toast";

// "Ask me before an agent sends", for each newsletter. Dashboard only: no key or app can change it.
export default function CardAgentApproval({ newsletters }) {
	const [values, setValues] = useState(() => Object.fromEntries(newsletters.map(({ id, required }) => [id, required])));
	const [, startTransition] = useTransition();

	function change(id, required) {
		setValues((current) => ({ ...current, [id]: required }));
		startTransition(async () => {
			const result = await setAgentApproval(id, required);
			if (result?.error) {
				setValues((current) => ({ ...current, [id]: !required }));
				toast.error(result.error);
			} else toast.success(required ? "Agents ask before they send" : "A key's own level decides again");
		});
	}

	return (
		<section className="flex flex-col gap-3 rounded-xl bg-card p-4 shadow-border animate-enter sm:p-5">
			<div>
				<h2 className="font-semibold tracking-tight">Ask me before an agent sends</h2>
				<p className="mt-1 max-w-xl text-sm text-pretty text-muted-foreground">
					When it is on, anything an API key or connected app does that sends, schedules or deletes waits here for you, whatever the key&apos;s level. Keys that
					already ask (send with approval) always do.
				</p>
			</div>
			<ul className="divide-y divide-border/60">
				{newsletters.map(({ id, name }) => (
					<li key={id} className="flex items-center justify-between gap-3 py-2.5">
						<label htmlFor={`ask-${id}`} className="min-w-0 truncate text-sm font-medium">
							{name}
						</label>
						<Switch id={`ask-${id}`} checked={Boolean(values[id])} onCheckedChange={(checked) => change(id, checked)} />
					</li>
				))}
			</ul>
		</section>
	);
}
