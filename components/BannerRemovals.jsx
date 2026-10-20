"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { getRemovals, retryRemoval } from "@/app/(app)/contacts/actions";
import { Button } from "@/components/ui/button";
import { describeRemoval } from "@/lib/bulk-removal-rules";
import { toast } from "@/lib/toast";

const POLL_MS = 3000;

// Deleted tags and fields coming off a large list in the background (lib/bulk-removal.js): how far each got, asked again
// every few seconds while one runs. One that ends while the page watches says so in a toast, and the list reloads.
export default function BannerRemovals({ newsletterId, initial }) {
	const router = useRouter();
	const [removals, setRemovals] = useState(initial);
	const [isRetrying, startRetry] = useTransition();
	const watched = useRef(new Set());
	const running = removals.filter(({ status }) => status === "running");
	const stopped = removals.filter(({ status }) => status === "failed");

	useEffect(() => {
		let isChanged = false;
		for (const removal of removals) {
			if (removal.status === "running") watched.current.add(removal.id);
			else if (watched.current.delete(removal.id)) {
				isChanged = true;
				if (removal.status === "done") toast.success(describeRemoval(removal));
				else toast.error(`${describeRemoval(removal)}. Some contacts still have it.`);
			}
		}
		if (isChanged) router.refresh();
	}, [removals, router]);

	useEffect(() => {
		if (running.length === 0) return;
		const interval = setInterval(async () => {
			const result = await getRemovals(newsletterId);
			if (result?.removals) setRemovals(result.removals);
		}, POLL_MS);
		return () => clearInterval(interval);
	}, [running.length, newsletterId]);

	function retry(id) {
		startRetry(async () => {
			const result = await retryRemoval(id);
			if (result.error) return void toast.error(result.error);
			setRemovals((current) => current.map((removal) => (removal.id === id ? result.removal : removal)));
		});
	}

	if (running.length === 0 && stopped.length === 0) return null;

	return (
		<div role="status" className="flex flex-col gap-3 rounded-xl bg-muted/60 px-4 py-3 text-sm animate-enter">
			{running.map((removal) => (
				<div key={removal.id} className="flex flex-col gap-2">
					<p className="flex items-center gap-2">
						<Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
						<span className="tabular-nums">{describeRemoval(removal)}</span>
					</p>
					<div
						role="progressbar"
						aria-label={`Removing ${removal.label}`}
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={removal.percent}
						className="h-1.5 overflow-hidden rounded-full bg-background"
					>
						<div className="h-full rounded-full bg-foreground transition-[width] duration-500" style={{ width: `${Math.max(removal.percent, 2)}%` }} />
					</div>
				</div>
			))}
			{stopped.map((removal) => (
				<p key={removal.id} className="flex flex-wrap items-center justify-between gap-2">
					<span className="text-pretty">{describeRemoval(removal)}. Some contacts still have it.</span>
					<Button variant="outline" size="sm" disabled={isRetrying} onClick={() => retry(removal.id)}>
						Try again
					</Button>
				</p>
			))}
		</div>
	);
}
