"use client";

import { useState, useTransition } from "react";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { rateBriefingStory } from "@/app/(app)/briefings/actions";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";

// Keep or drop on a story of a briefing run: later runs pick more stories like the kept ones. Pressing the other one changes it.
export default function ButtonsVerdict({ briefingId, runId, storyKey, verdict: initial }) {
	const [verdict, setVerdict] = useState(initial);
	const [isPending, startTransition] = useTransition();

	function rate(next) {
		startTransition(async () => {
			const result = await rateBriefingStory(briefingId, runId, storyKey, next);
			if (result?.error) return void toast.error(result.error);
			setVerdict(result.verdict);
		});
	}

	return (
		<span className="inline-flex gap-1">
			<Button type="button" size="sm" variant={verdict === "keep" ? "default" : "outline"} onClick={() => rate("keep")} disabled={isPending} aria-pressed={verdict === "keep"}>
				<ThumbsUp data-icon="inline-start" />
				Keep
			</Button>
			<Button type="button" size="sm" variant={verdict === "drop" ? "default" : "outline"} onClick={() => rate("drop")} disabled={isPending} aria-pressed={verdict === "drop"}>
				<ThumbsDown data-icon="inline-start" />
				Drop
			</Button>
		</span>
	);
}
