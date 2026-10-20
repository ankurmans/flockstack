"use client";

import { useState } from "react";
import { Check, Copy, Loader2, RefreshCw } from "lucide-react";
import NoteAiUsage from "@/components/NoteAiUsage";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PLATFORM_NAMES, X_LIMIT } from "@/lib/ai-writing";
import { toast } from "@/lib/toast";

// Plain copy for a LinkedIn post and a post on X, from the issue. FlockStack posts nothing: the writer edits it, copies it
// and posts it where it belongs.
export default function DialogSocialPosts({ isOpen, onOpenChange, run, onRetry }) {
	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>Social posts</DialogTitle>
					<DialogDescription>Drafts to edit and post yourself. FlockStack never posts for you.</DialogDescription>
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
					<div className="flex max-h-[60dvh] flex-col gap-5 overflow-y-auto">
						{Object.entries(run.data.posts).map(([platform, post]) => (
							<PostEditor key={`${platform}:${post}`} platform={platform} initial={post} />
						))}
						<NoteAiUsage usage={run.data.usage} />
					</div>
				)}
				<DialogFooter>
					<Button variant="outline" onClick={onRetry} disabled={run.status === "loading"}>
						<RefreshCw data-icon="inline-start" />
						Write again
					</Button>
					<Button onClick={() => onOpenChange(false)}>Done</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function PostEditor({ platform, initial }) {
	const [text, setText] = useState(initial);
	const [isCopied, setIsCopied] = useState(false);
	const id = `post-${platform}`;

	async function copy() {
		try {
			await navigator.clipboard.writeText(text);
			setIsCopied(true);
			setTimeout(() => setIsCopied(false), 1500);
		} catch {
			toast.error("Couldn't copy. Select the text and copy it.");
		}
	}

	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center justify-between">
				<Label htmlFor={id}>{PLATFORM_NAMES[platform]}</Label>
				<span className="flex items-center gap-3">
					{platform === "x" && (
						<span className={text.length > X_LIMIT ? "text-xs text-destructive tabular-nums" : "text-xs text-muted-foreground tabular-nums"}>
							{text.length} / {X_LIMIT}
						</span>
					)}
					<Button variant="ghost" size="sm" onClick={copy}>
						{isCopied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
						{isCopied ? "Copied" : "Copy"}
					</Button>
				</span>
			</div>
			<Textarea id={id} value={text} onChange={(event) => setText(event.target.value)} rows={platform === "x" ? 4 : 10} />
		</div>
	);
}
