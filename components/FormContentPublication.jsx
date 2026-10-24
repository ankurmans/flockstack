"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { recordContentPublication } from "@/app/(app)/campaigns/calendar/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/lib/toast";

// For a post published by hand: the address of the post on LinkedIn and when it went up. Recording it moves the item to
// delivered. FlockStack posts nothing; this only keeps what the owner did. For an issue, it is recorded once the campaign is sent.
export default function FormContentPublication({ item }) {
	const router = useRouter();
	const isPost = item.channel === "linkedin";
	const [values, setValues] = useState({ url: item.publicationUrl ?? "", deliveredAt: item.deliveredAt ? item.deliveredAt.slice(0, 16) : "" });
	const [isSaving, startSaving] = useTransition();

	function record(published) {
		startSaving(async () => {
			const deliveredAt = values.deliveredAt ? `${values.deliveredAt}:00Z` : "";
			const result = await recordContentPublication(item.id, published ? { url: values.url, deliveredAt } : { published: false });
			if (result?.error) return void toast.error(result.error);
			toast.success(published ? "Recorded as delivered" : "Back to approved");
			router.refresh();
		});
	}

	const canRecord = ["approved", "delivered"].includes(item.state) && (isPost || item.campaign?.status === "sent");

	return (
		<section className="rounded-xl bg-card shadow-border animate-enter" aria-label="Publication">
			<h2 className="flex h-12 items-center px-4 text-sm font-medium">{isPost ? "Published by hand" : "Delivered"}</h2>
			<form
				className="grid gap-3 border-t border-border/60 px-4 py-3"
				onSubmit={(event) => {
					event.preventDefault();
					record(true);
				}}
			>
				{isPost && (
					<label className="flex flex-col gap-1 text-xs text-muted-foreground">
						Address of the post on LinkedIn
						<Input type="url" value={values.url} onChange={(event) => setValues((current) => ({ ...current, url: event.target.value }))} placeholder="https://www.linkedin.com/posts/…" disabled={!canRecord} />
					</label>
				)}
				<label className="flex flex-col gap-1 text-xs text-muted-foreground">
					When it went out (UTC)
					<Input type="datetime-local" value={values.deliveredAt} onChange={(event) => setValues((current) => ({ ...current, deliveredAt: event.target.value }))} disabled={!canRecord} />
				</label>
				<div className="flex flex-wrap gap-2">
					<Button type="submit" disabled={isSaving || !canRecord || (isPost && !values.url)}>
						{item.state === "delivered" ? "Update the record" : "Record as delivered"}
					</Button>
					{item.state === "delivered" && (
						<Button type="button" variant="ghost" disabled={isSaving} onClick={() => record(false)}>
							Take the record back
						</Button>
					)}
				</div>
				<p className="text-xs text-muted-foreground">
					{canRecord
						? isPost
							? "This records what you did. It doesn't post anything."
							: "The issue was sent by its campaign. This records it in the plan."
						: isPost
							? "Approve the post first, then post it on LinkedIn and record it here."
							: "Recorded after the campaign has been sent."}
				</p>
			</form>
		</section>
	);
}
