"use client";

import { CornerDownLeft, Loader2, RefreshCw } from "lucide-react";
import NoteAiUsage from "@/components/NoteAiUsage";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { REWRITE_STYLES } from "@/lib/ai-writing";

// The AI's version of the selected text, as a preview. The writer replaces the selection with it, adds it below, tries
// again or discards it; nothing changes until a button says so.
export default function DialogAiRewrite({ request, run, canReplace, onReplace, onInsertBelow, onRetry, onClose }) {
	const style = request ? REWRITE_STYLES[request.style] : null;
	const title = style ? (request.style === "translate" ? `Translate to ${request.language}` : style.title) : "AI";

	return (
		<Dialog open={Boolean(request)} onOpenChange={(isOpen) => !isOpen && onClose()}>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>A suggestion for the text you selected. Nothing changes until you choose.</DialogDescription>
				</DialogHeader>
				{run.status === "loading" && (
					<div className="flex items-center gap-2 py-8 text-sm text-muted-foreground" role="status">
						<Loader2 className="size-4 animate-spin" />
						Writing…
					</div>
				)}
				{run.status === "error" && (
					<p role="alert" className="rounded-lg bg-muted p-3 text-sm text-pretty">
						{run.error}
					</p>
				)}
				{run.status === "done" && (
					<div className="flex flex-col gap-3">
						<div className="max-h-72 overflow-y-auto rounded-lg border border-border p-3 text-sm whitespace-pre-wrap" aria-label="Suggestion">
							{run.data.text}
						</div>
						<details className="text-sm text-muted-foreground">
							<summary className="cursor-pointer select-none">Your original</summary>
							<p className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap">{request.text}</p>
						</details>
						{!canReplace && <p className="text-xs text-muted-foreground">The text changed since you selected it, so it can only be added below.</p>}
						<NoteAiUsage usage={run.data.usage} />
					</div>
				)}
				<DialogFooter>
					<Button variant="outline" onClick={onClose}>
						Discard
					</Button>
					<Button variant="outline" onClick={onRetry} disabled={run.status === "loading"}>
						<RefreshCw data-icon="inline-start" />
						Try again
					</Button>
					<Button variant="outline" onClick={() => onInsertBelow(run.data.text)} disabled={run.status !== "done"}>
						Add below
					</Button>
					<Button onClick={() => onReplace(run.data.text)} disabled={run.status !== "done" || !canReplace}>
						<CornerDownLeft data-icon="inline-start" />
						Replace
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
