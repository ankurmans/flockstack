"use client";

import { useState, useTransition } from "react";
import { Check, Copy, Gift, Loader2 } from "lucide-react";
import { makeGiftLink } from "@/app/archive/reader-actions";
import { Button } from "@/components/ui/button";

// A paid reader's button on the paid issue they are reading: a link that opens this one issue for a friend, within the limits the
// owner set (lib/gift-links.js). The link is shown here once it is made, to copy.
export default function ShareGiftLink({ slug, post }) {
	const [made, setMade] = useState(null);
	const [problem, setProblem] = useState(null);
	const [isCopied, setIsCopied] = useState(false);
	const [isPending, startTransition] = useTransition();

	function make() {
		startTransition(async () => {
			setProblem(null);
			try {
				const answer = await makeGiftLink(slug, post);
				if (answer?.url) setMade(answer);
				else setProblem(answer?.error ?? "Could not make a link. Try again.");
			} catch {
				setProblem("Could not make a link. Try again.");
			}
		});
	}

	async function copy() {
		try {
			await navigator.clipboard.writeText(made.url);
			setIsCopied(true);
			setTimeout(() => setIsCopied(false), 1500);
		} catch {
			setProblem("Couldn't copy. Select the link and copy it.");
		}
	}

	return (
		<div className="mt-10 flex flex-col gap-3 rounded-xl p-4 text-sm shadow-border">
			{made ? (
				<>
					<p className="font-medium">Your link to this issue</p>
					<div className="flex items-center gap-2">
						<input readOnly value={made.url} aria-label="Gift link" onFocus={(event) => event.target.select()} className="h-9 min-w-0 flex-1 rounded-lg bg-background px-3 text-sm shadow-border" />
						<Button type="button" variant="outline" size="sm" onClick={copy}>
							{isCopied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
							{isCopied ? "Copied" : "Copy"}
						</Button>
					</div>
					<p className="text-muted-foreground text-pretty">
						It opens this one issue in {made.opens} {made.opens === 1 ? "browser" : "browsers"} for {made.days} days.{" "}
						{made.left > 0 ? `You can make ${made.left} more this month.` : "That was your last one this month."}
					</p>
				</>
			) : (
				<div className="flex items-center justify-between gap-3">
					<p className="text-pretty text-muted-foreground">Know someone who would like this issue? Give them a link to read it.</p>
					<Button type="button" variant="outline" size="sm" onClick={make} disabled={isPending}>
						{isPending ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <Gift data-icon="inline-start" />}
						Share this issue
					</Button>
				</div>
			)}
			{problem && (
				<p role="alert" className="text-destructive">
					{problem}
				</p>
			)}
		</div>
	);
}
