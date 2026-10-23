"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Bot, Check, Loader2, TriangleAlert, X } from "lucide-react";
import { decideApproval } from "@/app/(app)/approvals/actions";
import ApprovalCheck from "@/components/ApprovalCheck";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { formatRelative } from "@/lib/format";
import { toast } from "@/lib/toast";

const MAX_INPUT_CHARS = 6000;
// Requests that start a campaign's send, whose draft has the ready-to-send check.
const CHECKED_ACTIONS = new Set(["send_campaign", "schedule_campaign"]);
const REASONS = {
	key: "This key asks before it sends or deletes.",
	newsletter: "This newsletter asks before an agent sends or deletes.",
	scale: "It changes a lot of contacts at once.",
};

// One request an agent made, waiting for the owner: what would happen, the exact input that will run, and the two answers.
// staleness: why approving needs a second look (the campaign was edited since).
export default function CardApproval({ approval, staleness = null }) {
	const [isPending, startTransition] = useTransition();
	const [note, setNote] = useState("");
	const [warning, setWarning] = useState(staleness);
	const [decision, setDecision] = useState(null);
	const input = approval.input ? JSON.stringify(approval.input, null, 2) : "";

	function decide(choice) {
		setDecision(choice);
		startTransition(async () => {
			const result = await decideApproval(approval.id, choice, note, choice === "approve" && Boolean(warning));
			if (result?.error) return void toast.error(result.error);
			if (result?.stale) return void setWarning(result.stale);
			if (choice === "reject") return void toast.success("Rejected. Nothing was done.");
			if (result.approval.execution.state === "failed") toast.error(`Approved, but it failed: ${result.approval.execution.error?.message}`);
			else toast.success("Approved. It ran.");
		});
	}

	return (
		<article data-approval={approval.id} className="flex flex-col gap-4 rounded-xl bg-card p-4 shadow-border animate-enter sm:p-5">
			<header className="flex flex-wrap items-start justify-between gap-2">
				<div className="min-w-0">
					<h2 className="text-base font-semibold tracking-tight text-balance">{approval.preview?.title ?? approval.action}</h2>
					<p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
						<Bot aria-hidden className="size-3.5 shrink-0" />
						<span className="truncate">
							{approval.actor.name} · {approval.actor.type === "key" ? "API key" : "connected app"} · asked {formatRelative(approval.createdAt)}
						</span>
					</p>
				</div>
				<span className="text-xs text-muted-foreground">{REASONS[approval.reason]}</span>
			</header>

			{warning && (
				<p role="alert" className="flex items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-pretty">
					<TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
					<span>
						<span className="font-medium">Look again before you approve.</span> {warning} The details below are from when it was asked; open the draft to see it now.
					</span>
				</p>
			)}

			{approval.preview?.lines?.length > 0 && (
				<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
					{approval.preview.lines.map(([label, value]) => (
						<div key={label} className="contents">
							<dt className="text-muted-foreground">{label}</dt>
							<dd className="min-w-0 break-words">{value}</dd>
						</div>
					))}
				</dl>
			)}

			{approval.preview?.links?.length > 0 && (
				<p className="flex flex-wrap gap-x-4 text-sm">
					{approval.preview.links.map(({ label, href }) => (
						<Link key={href} href={href} target="_blank" className="text-link underline decoration-link/30 underline-offset-4 hover:decoration-link">
							{label}
						</Link>
					))}
				</p>
			)}

			{CHECKED_ACTIONS.has(approval.action) && approval.input?.id && <ApprovalCheck campaignId={String(approval.input.id)} />}

			<details className="text-sm">
				<summary className="cursor-pointer text-muted-foreground">The exact input that will run</summary>
				<pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-muted/60 p-3 font-mono text-xs">
					{input.length > MAX_INPUT_CHARS ? `${input.slice(0, MAX_INPUT_CHARS)}\n… ${input.length - MAX_INPUT_CHARS} more characters` : input}
				</pre>
				<p className="mt-1 font-mono text-xs text-muted-foreground">Fingerprint {approval.inputHash.slice(0, 16)}. It can&apos;t change after the request.</p>
			</details>

			<Textarea
				value={note}
				onChange={(event) => setNote(event.target.value)}
				maxLength={500}
				rows={1}
				placeholder="A note for the agent (optional)"
				aria-label="A note for the agent"
			/>

			<footer className="flex flex-wrap items-center justify-end gap-2">
				<Button variant="outline" disabled={isPending} onClick={() => decide("reject")}>
					{isPending && decision === "reject" ? <Loader2 className="animate-spin" /> : <X data-icon="inline-start" />}
					Reject
				</Button>
				<Button disabled={isPending} onClick={() => decide("approve")}>
					{isPending && decision === "approve" ? <Loader2 className="animate-spin" /> : <Check data-icon="inline-start" />}
					{warning ? "Approve the current version" : "Approve"}
				</Button>
			</footer>
		</article>
	);
}
