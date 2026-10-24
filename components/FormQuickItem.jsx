"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Plus } from "lucide-react";
import { createContentItem } from "@/app/(app)/campaigns/calendar/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/lib/toast";

const SELECT_CLASS = "h-9 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25";

// A new item for the backlog: a title, a channel and, if known, the funnel stage. It opens in the editor to be written.
export default function FormQuickItem({ newsletterId }) {
	const router = useRouter();
	const [values, setValues] = useState({ title: "", channel: "linkedin", funnelStage: "" });
	const [isAdding, startAdding] = useTransition();

	function add(event) {
		event.preventDefault();
		startAdding(async () => {
			const result = await createContentItem(newsletterId, values);
			if (result?.error) return void toast.error(result.error);
			router.push(`/campaigns/calendar/items/${result.id}`);
		});
	}

	return (
		<form onSubmit={add} className="flex flex-col gap-2 px-4 py-3">
			<label htmlFor="quick-title" className="text-sm font-medium">
				New item
			</label>
			<Input id="quick-title" value={values.title} onChange={(event) => setValues((current) => ({ ...current, title: event.target.value }))} placeholder="Title" maxLength={200} required />
			<div className="flex flex-wrap gap-2">
				<label className="sr-only" htmlFor="quick-channel">
					Channel
				</label>
				<select id="quick-channel" value={values.channel} onChange={(event) => setValues((current) => ({ ...current, channel: event.target.value }))} className={SELECT_CLASS}>
					<option value="linkedin">LinkedIn post</option>
					<option value="newsletter">Newsletter issue</option>
				</select>
				<label className="sr-only" htmlFor="quick-stage">
					Funnel stage
				</label>
				<select id="quick-stage" value={values.funnelStage} onChange={(event) => setValues((current) => ({ ...current, funnelStage: event.target.value }))} className={SELECT_CLASS}>
					<option value="">No stage</option>
					<option value="TOFU">TOFU</option>
					<option value="MOFU">MOFU</option>
					<option value="BOFU">BOFU</option>
				</select>
				<Button type="submit" variant="outline" disabled={isAdding || !values.title.trim()}>
					<Plus data-icon="inline-start" />
					Add
				</Button>
			</div>
		</form>
	);
}
