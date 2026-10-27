"use client";
import NoticeReplyRules from "@/components/NoticeReplyRules";
import useReaderText from "@/components/useReaderText";

import { useActionState, useEffect, useEffectEvent, useRef } from "react";
import { Loader2 } from "lucide-react";
import { submitComment } from "@/app/archive/comment-actions";
import { Button } from "@/components/ui/button";
import { useComments } from "@/components/ProviderComments";
import { MAX_COMMENT_CHARS } from "@/lib/comment-body";
import { DISPLAY_NAME_MAX } from "@/lib/comment-rules";

// The box for a comment, or a reply when parent is a comment's ID. On a reader's first comment it also asks what name to
// use, with their address's first part filled in; that name is set once.
export default function FormComment({ parent = null, onDone, label = "Your comment" }) {
	const t = useReaderText();
	const { slug, post, viewer, refresh } = useComments();
	const [state, action, isPending] = useActionState(submitComment, null);
	const formRef = useRef(null);
	const fieldId = `comment-body-${parent ?? "new"}`;

	const finish = useEffectEvent((result) => {
		formRef.current?.reset();
		refresh();
		if (result.status === "published") onDone?.();
	});
	useEffect(() => {
		if (state?.ok) finish(state);
	}, [state]);

	const needsName = !viewer.name?.isLocked;
	return (
		<form ref={formRef} action={action} className="flex flex-col gap-3">
			<input type="hidden" name="newsletter" value={slug} />
			<input type="hidden" name="p" value={post} />
			{parent && <input type="hidden" name="parent" value={parent} />}
			<div aria-hidden="true" className="absolute -left-[10000px] size-px overflow-hidden">
				<input type="text" name="website" tabIndex={-1} autoComplete="off" />
			</div>
			{needsName && (
				<div className="flex flex-col gap-1.5">
					<label htmlFor={`${fieldId}-name`} className="text-sm font-medium">
						{t("Your name")}
					</label>
					<input
						id={`${fieldId}-name`}
						type="text"
						name="name"
						defaultValue={viewer.name?.suggested ?? ""}
						maxLength={DISPLAY_NAME_MAX}
						autoComplete="nickname"
						aria-describedby={`${fieldId}-name-hint`}
						className="h-11 w-full rounded-xl bg-background px-3.5 text-base shadow-border outline-none transition-shadow duration-150 focus-visible:shadow-border-hover focus-visible:ring-3 focus-visible:ring-ring/25 sm:max-w-xs"
					/>
					<p id={`${fieldId}-name-hint`} className="text-xs text-pretty text-muted-foreground">
						{t("Shown next to your comments, never your email address. You set it once, with your first comment.")}
					</p>
				</div>
			)}
			<div className="flex flex-col gap-1.5">
				<label htmlFor={fieldId} className="text-sm font-medium">
					{t(label)}
				</label>
				<textarea
					id={fieldId}
					name="body"
					required
					rows={parent ? 3 : 4}
					maxLength={MAX_COMMENT_CHARS}
					autoFocus={Boolean(parent)}
					aria-describedby={state?.error ? `${fieldId}-error` : `${fieldId}-hint`}
					className="min-h-24 w-full resize-y rounded-xl bg-background px-3.5 py-3 text-base shadow-border outline-none transition-shadow duration-150 placeholder:text-muted-foreground focus-visible:shadow-border-hover focus-visible:ring-3 focus-visible:ring-ring/25"
				/>
				<p id={`${fieldId}-hint`} className="text-xs text-muted-foreground">
					{t("Plain text. A link is a web address or [words](https://address).")}
				</p>
			</div>
			<NoticeReplyRules id={fieldId} />
			<div className="flex flex-wrap items-center gap-3">
				<Button type="submit" disabled={isPending} className="h-11 min-w-28 rounded-xl px-5">
					{isPending ? <Loader2 className="animate-spin" /> : parent ? t("Reply") : t("Post comment")}
				</Button>
				{parent && (
					<Button type="button" variant="ghost" className="h-11 rounded-xl px-4" onClick={() => onDone?.()}>
						{t("Cancel")}
					</Button>
				)}
			</div>
			{state?.error && (
				<p id={`${fieldId}-error`} role="alert" className="text-sm text-destructive">
					{t.error(state.error)}
				</p>
			)}
			{state?.ok && state.status === "held" && (
				<p role="status" className="rounded-xl bg-amber-50 p-3 text-sm text-pretty text-amber-950 ring-1 ring-amber-500/30 dark:bg-amber-500/10 dark:text-amber-50">
					{t("Thanks. Your comment is waiting for the newsletter's owner to review, and will show once they approve it.")} {t.error(state.reason)}
				</p>
			)}
			{state?.ok && state.status === "hidden" && <p role="status" className="text-sm">{t.error(state.reason)} {t("The newsletter's owner can review this decision.")}</p>}
			{state?.ok && state.status === "published" && !parent && (
				<p role="status" className="text-sm text-muted-foreground">
					{t("Posted.")}
				</p>
			)}
		</form>
	);
}
