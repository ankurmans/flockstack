"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createEditorialBatch } from "@/app/(app)/campaigns/calendar/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/lib/toast";

// A batch groups items that belong together, such as a launch or a month of posts.
export default function FormNewBatch({ newsletterId }) {
	const router = useRouter();
	const [name, setName] = useState("");
	const [isAdding, startAdding] = useTransition();

	return (
		<form
			className="flex flex-col gap-2 px-4 py-3"
			onSubmit={(event) => {
				event.preventDefault();
				startAdding(async () => {
					const result = await createEditorialBatch(newsletterId, name);
					if (result?.error) return void toast.error(result.error);
					router.push(`/campaigns/calendar/batches/${result.id}`);
				});
			}}
		>
			<label htmlFor="new-batch" className="text-sm font-medium">
				New batch
			</label>
			<div className="flex gap-2">
				<Input id="new-batch" value={name} onChange={(event) => setName(event.target.value)} placeholder="November launch" maxLength={120} required />
				<Button type="submit" variant="outline" disabled={isAdding || !name.trim()}>
					Add
				</Button>
			</div>
		</form>
	);
}
