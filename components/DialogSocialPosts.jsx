"use client";

import { useState } from "react";
import { Check, Copy, Loader2, RefreshCw } from "lucide-react";
import NoteAiUsage from "@/components/NoteAiUsage";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DEFAULT_SOCIAL_PLATFORMS, PLATFORM_NAMES, SOCIAL_PLATFORMS, countPost, getPostLimit } from "@/lib/ai-writing";
import { toast } from "@/lib/toast";

// Plain copy for a post on each platform chosen, from the issue. FlockStack posts nothing: the writer edits it, copies it
// and posts it where it belongs.
export default function DialogSocialPosts({ isOpen, onOpenChange, run, onRetry, onSave }) {
	const [platforms, setPlatforms] = useState(DEFAULT_SOCIAL_PLATFORMS);
	const toggle = (platform) => setPlatforms((current) => (current.includes(platform) ? current.filter((item) => item !== platform) : SOCIAL_PLATFORMS.filter((item) => item === platform || current.includes(item))));
	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>Social posts</DialogTitle>
					<DialogDescription>Drafts to edit and post yourself. FlockStack never posts for you.</DialogDescription>
				</DialogHeader>
				<fieldset className="flex flex-wrap gap-x-4 gap-y-2" disabled={run.status === "loading"}>
					<legend className="sr-only">Platforms</legend>
					{SOCIAL_PLATFORMS.map((platform) => (
						<label key={platform} className="flex items-center gap-2 text-sm">
							<input type="checkbox" checked={platforms.includes(platform)} onChange={() => toggle(platform)} className="size-4 accent-foreground" />
							{PLATFORM_NAMES[platform]}
						</label>
					))}
				</fieldset>
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
							<PostEditor key={`${platform}:${post}`} platform={platform} initial={post} onSave={platform === "linkedin" ? onSave : undefined} />
						))}
						<NoteAiUsage usage={run.data.usage} />
					</div>
				)}
				<DialogFooter>
					<Button variant="outline" onClick={() => onRetry(platforms)} disabled={run.status === "loading" || platforms.length === 0}>
						<RefreshCw data-icon="inline-start" />
						Write again
					</Button>
					<Button onClick={() => onOpenChange(false)}>Done</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function PostEditor({ platform, initial, onSave }) {
	const [text, setText] = useState(initial);
	const [isCopied, setIsCopied] = useState(false);
	const [saved, setSaved] = useState(null);
	const [isSaving, setIsSaving] = useState(false);
	const id = `post-${platform}`;
	const limit = getPostLimit(platform, null);
	const count = countPost(platform, text);

	async function copy() {
		try {
			await navigator.clipboard.writeText(text);
			setIsCopied(true);
			setTimeout(() => setIsCopied(false), 1500);
		} catch {
			toast.error("Couldn't copy. Select the text and copy it.");
		}
	}

	async function save() {
		setIsSaving(true);
		const result = await onSave(text);
		setIsSaving(false);
		if (result?.error) return void toast.error(result.error);
		setSaved(result.href);
	}

	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center justify-between">
				<Label htmlFor={id}>{PLATFORM_NAMES[platform]}</Label>
				<span className="flex items-center gap-3">
					{limit && (
						<span className={count > limit ? "text-xs text-destructive tabular-nums" : "text-xs text-muted-foreground tabular-nums"}>
							{count} / {limit}
						</span>
					)}
					{onSave && (saved ? (
						<a href={saved} className="text-sm text-link hover:underline">
							Saved to the plan
						</a>
					) : (
						<Button variant="ghost" size="sm" onClick={save} disabled={isSaving}>
							Save to the plan
						</Button>
					))}
					<Button variant="ghost" size="sm" onClick={copy}>
						{isCopied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
						{isCopied ? "Copied" : "Copy"}
					</Button>
				</span>
			</div>
			<Textarea id={id} value={text} onChange={(event) => setText(event.target.value)} rows={limit && limit <= 300 ? 4 : platform === "facebook" || platform === "threads" ? 6 : 10} />
		</div>
	);
}
