"use client";

import { useState, useTransition } from "react";
import { setAgentApproval } from "@/app/(app)/approvals/actions";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/lib/toast";

// "Ask me before an agent sends", for each newsletter. Dashboard only: no key or app can change it. unchosen: the newsletters
// from before it was on by default, which nobody switched: the card offers to turn it on for them.
export default function CardAgentApproval({ newsletters, unchosen = [] }) {
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

	const offered = unchosen.filter((id) => !values[id]);

	return (
		<section className="flex flex-col gap-3 rounded-xl bg-card p-4 shadow-border animate-enter sm:p-5">
			{offered.length > 0 && (
				<div role="status" className="flex flex-col gap-2 rounded-lg bg-amber-500/10 px-3 py-2.5 text-sm text-pretty sm:flex-row sm:items-center sm:justify-between">
					<span>
						<span className="font-medium">Safer default.</span> New newsletters ask before an agent sends, deletes or changes billing. {offered.length === 1 ? "One of yours doesn't" : `${offered.length} of yours don't`} yet:
						a full access key there sends with no review.
					</span>
					<Button size="sm" variant="outline" className="shrink-0" onClick={() => offered.forEach((id) => change(id, true))}>
						Turn it on
					</Button>
				</div>
			)}
			<div>
				<h2 className="font-semibold tracking-tight">Ask me before an agent sends</h2>
				<p className="mt-1 max-w-xl text-sm text-pretty text-muted-foreground">
					When it is on, anything an API key or connected app does that sends, schedules, deletes or changes billing waits here for you, whatever the key&apos;s
					level, full access included. Keys that already ask (send with approval) always do. Every change is in the agent activity log.
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
