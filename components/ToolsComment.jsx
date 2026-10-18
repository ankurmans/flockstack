"use client";

import { useActionState, useEffect, useEffectEvent, useState } from "react";
import { Loader2 } from "lucide-react";
import { submitDelete, submitEdit, submitReport } from "@/app/archive/comment-actions";
import FormComment from "@/components/FormComment";
import { useComments } from "@/components/ProviderComments";
import { Button } from "@/components/ui/button";
import { MAX_COMMENT_CHARS } from "@/lib/comment-body";

const LINK = "inline-flex h-9 items-center rounded-lg px-2 text-sm text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none sm:h-8";

// What the signed-in reader can do with one comment: reply to it, report it, or, for their own, change it for a few minutes
// and delete it. Nothing shows to a visitor who isn't signed in.
export default function ToolsComment({ id, canReply }) {
	const { viewer } = useComments();
	const [mode, setMode] = useState(null);
	if (!viewer.signedIn) return null;

	const own = viewer.own?.find((comment) => comment.id === id);
	const canComment = viewer.access?.ok;
	const isReported = viewer.reported?.includes(id);
	const canEdit = own?.editableUntil && new Date(own.editableUntil) > new Date();

	return (
		<div className="mt-1 -ml-2">
			<div className="flex flex-wrap items-center gap-x-1">
				{canReply && canComment && !own && (
					<button type="button" className={LINK} aria-expanded={mode === "reply"} onClick={() => setMode(mode === "reply" ? null : "reply")}>
						Reply
					</button>
				)}
				{own && canEdit && (
					<button type="button" className={LINK} aria-expanded={mode === "edit"} onClick={() => setMode(mode === "edit" ? null : "edit")}>
						Edit
					</button>
				)}
				{own && (
					<button type="button" className={LINK} aria-expanded={mode === "delete"} onClick={() => setMode(mode === "delete" ? null : "delete")}>
						Delete
					</button>
				)}
				{!own && !isReported && (
					<button type="button" className={LINK} aria-expanded={mode === "report"} onClick={() => setMode(mode === "report" ? null : "report")}>
						Report
					</button>
				)}
				{!own && isReported && <span className="px-2 text-sm text-muted-foreground">Reported</span>}
			</div>
			{mode === "reply" && (
				<div className="mt-2 ml-2">
					<FormComment parent={id} label="Your reply" onDone={() => setMode(null)} />
				</div>
			)}
			{mode === "edit" && own && (
				<div className="mt-2 ml-2">
					<FormEdit comment={own} onDone={() => setMode(null)} />
				</div>
			)}
			{mode === "delete" && own && (
				<div className="mt-2 ml-2">
					<FormDelete id={id} onDone={() => setMode(null)} />
				</div>
			)}
			{mode === "report" && (
				<div className="mt-2 ml-2">
					<FormReport id={id} onDone={() => setMode(null)} />
				</div>
			)}
		</div>
	);
}

// The field names the server actions read.
function Fields({ id }) {
	const { slug, post } = useComments();
	return (
		<>
			<input type="hidden" name="newsletter" value={slug} />
			<input type="hidden" name="p" value={post} />
			<input type="hidden" name="comment" value={id} />
		</>
	);
}

export function FormEdit({ comment, onDone }) {
	const { refresh } = useComments();
	const [state, action, isPending] = useActionState(submitEdit, null);
	const finish = useEffectEvent(() => {
		refresh();
		onDone?.();
	});
	useEffect(() => {
		if (state?.ok) finish();
	}, [state]);

	return (
		<form action={action} className="flex flex-col gap-2">
			<Fields id={comment.id} />
			<label htmlFor={`edit-${comment.id}`} className="text-sm font-medium">
				Change your comment
			</label>
			<textarea
				id={`edit-${comment.id}`}
				name="body"
				required
				rows={4}
				maxLength={MAX_COMMENT_CHARS}
				defaultValue={comment.body}
				className="min-h-24 w-full resize-y rounded-xl bg-background px-3.5 py-3 text-base shadow-border outline-none transition-shadow duration-150 focus-visible:shadow-border-hover focus-visible:ring-3 focus-visible:ring-ring/25"
			/>
			<div className="flex items-center gap-2">
				<Button type="submit" disabled={isPending} className="h-10 rounded-xl px-4">
					{isPending ? <Loader2 className="animate-spin" /> : "Save"}
				</Button>
				<Button type="button" variant="ghost" className="h-10 rounded-xl px-4" onClick={() => onDone?.()}>
					Cancel
				</Button>
			</div>
			{state?.error && (
				<p role="alert" className="text-sm text-destructive">
					{state.error}
				</p>
			)}
		</form>
	);
}

export function FormDelete({ id, onDone }) {
	const { refresh } = useComments();
	const [state, action, isPending] = useActionState(submitDelete, null);
	const finish = useEffectEvent(() => {
		refresh();
		onDone?.();
	});
	useEffect(() => {
		if (state?.ok) finish();
	}, [state]);

	return (
		<form action={action} className="flex flex-wrap items-center gap-2">
			<Fields id={id} />
			<p className="text-sm text-muted-foreground">Delete this comment? Your words are erased.</p>
			<Button type="submit" variant="destructive" disabled={isPending} className="h-10 rounded-xl px-4">
				{isPending ? <Loader2 className="animate-spin" /> : "Delete"}
			</Button>
			<Button type="button" variant="ghost" className="h-10 rounded-xl px-4" onClick={() => onDone?.()}>
				Keep it
			</Button>
			{state?.error && (
				<p role="alert" className="w-full text-sm text-destructive">
					{state.error}
				</p>
			)}
		</form>
	);
}

function FormReport({ id, onDone }) {
	const { refresh } = useComments();
	const [state, action, isPending] = useActionState(submitReport, null);
	const finish = useEffectEvent(() => {
		refresh();
		onDone?.();
	});
	useEffect(() => {
		if (state?.ok) finish();
	}, [state]);

	return (
		<form action={action} className="flex flex-col gap-2">
			<Fields id={id} />
			<label htmlFor={`report-${id}`} className="text-sm text-muted-foreground">
				Tell the newsletter&apos;s owner what is wrong with this comment. The reason is optional.
			</label>
			<input
				id={`report-${id}`}
				type="text"
				name="reason"
				maxLength={300}
				className="h-11 w-full rounded-xl bg-background px-3.5 text-base shadow-border outline-none transition-shadow duration-150 focus-visible:shadow-border-hover focus-visible:ring-3 focus-visible:ring-ring/25"
			/>
			<div className="flex items-center gap-2">
				<Button type="submit" disabled={isPending} className="h-10 rounded-xl px-4">
					{isPending ? <Loader2 className="animate-spin" /> : "Send report"}
				</Button>
				<Button type="button" variant="ghost" className="h-10 rounded-xl px-4" onClick={() => onDone?.()}>
					Cancel
				</Button>
			</div>
			{state?.error && (
				<p role="alert" className="text-sm text-destructive">
					{state.error}
				</p>
			)}
		</form>
	);
}
