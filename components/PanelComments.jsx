"use client";
import useReaderText from "@/components/useReaderText";

import { useState } from "react";
import { signOutReader } from "@/app/archive/comment-actions";
import CommentBody from "@/components/CommentBody";
import FormComment from "@/components/FormComment";
import FormCommentSignin from "@/components/FormCommentSignin";
import { useComments } from "@/components/ProviderComments";
import { FormDelete, FormEdit } from "@/components/ToolsComment";
import { parseCommentBody } from "@/lib/comment-body";

// What the reader sees above the discussion: the sign-in, or the box for a new comment, and any of their own comments
// that aren't on the page, each with the reason.
export default function PanelComments() {
	const t = useReaderText();
	const { slug, viewer, isLoaded, hasSession, linkProblem, restriction, refresh } = useComments();
	const aside = (viewer.own ?? []).filter(({ status }) => status !== "published");

	if (hasSession && !isLoaded) return <div aria-hidden="true" className="h-56 rounded-2xl bg-card shadow-border" />;
	return (
		<div className="flex flex-col gap-6">
			{!viewer.signedIn ? (
				<div className="flex flex-col gap-3 rounded-2xl bg-card p-5 shadow-border">
					{linkProblem && (
						<p role="alert" className="text-sm text-pretty text-destructive">
							{t("That link has expired or was already used. Ask for a new one below.")}
						</p>
					)}
					<h3 className="text-base font-semibold tracking-tight">{t("Join the discussion")}</h3>
					<p className="text-sm text-pretty text-muted-foreground">
						Subscribers can comment. Sign in with the email you subscribed with: we send you a link, so there is no password.
						{restriction && ` ${restriction}`}
					</p>
					<FormCommentSignin />
				</div>
			) : viewer.access?.ok ? (
				<div className="rounded-2xl bg-card p-5 shadow-border">
					<FormComment />
					<SignedInNote slug={slug} onSignedOut={refresh} />
				</div>
			) : (
				<div className="rounded-2xl bg-card p-5 shadow-border">
					<p role="status" className="text-sm text-pretty">
						{t.error(viewer.access?.message ?? "You can't comment here.")}
					</p>
					<SignedInNote slug={slug} onSignedOut={refresh} />
				</div>
			)}
			{isLoaded && aside.length > 0 && (
				<ul className="flex flex-col gap-3" aria-label={t("Your comments that aren't showing")}>
					{aside.map((comment) => (
						<AsideComment key={comment.id} comment={comment} />
					))}
				</ul>
			)}
		</div>
	);
}

function SignedInNote({ slug, onSignedOut }) {
	const t = useReaderText();
	return (
		<p className="mt-4 text-xs text-muted-foreground">
			{t("Signed in on this device.")}{" "}
			<button
				type="button"
				className="underline underline-offset-4 hover:text-foreground"
				onClick={async () => {
					await signOutReader(slug);
					onSignedOut();
				}}
			>
				{t("Sign out")}
			</button>
		</p>
	);
}

const TITLES = {
	held: "Waiting for the newsletter's owner to review",
	hidden: "Hidden by the newsletter's owner",
	removed: "Removed",
};

// A comment of the reader's own that the page doesn't show: held for review, hidden or removed. The reason is always here.
function AsideComment({ comment }) {
	const t = useReaderText();
	const [mode, setMode] = useState(null);
	const canEdit = comment.status === "held" && comment.editableUntil && new Date(comment.editableUntil) > new Date();
	const wasDeletedByAuthor = comment.status === "removed" && comment.decidedBy === "author";
	if (wasDeletedByAuthor) return null;

	return (
		<li className="rounded-xl bg-amber-50 p-4 ring-1 ring-amber-500/30 dark:bg-amber-500/10">
			<p className="text-sm font-medium text-amber-950 dark:text-amber-50">{t(TITLES[comment.status])}</p>
			{comment.reason && (
				<p className="mt-1 text-sm text-pretty text-amber-950/80 dark:text-amber-50/80">
					{t(comment.decidedBy === "creator" ? "Reason from the owner" : "Reason")}: {comment.decidedBy === "creator" ? comment.reason : t.error(comment.reason)}
				</p>
			)}
			{!comment.reason && <p className="mt-1 text-sm text-amber-950/80 dark:text-amber-50/80">{t(comment.decidedBy === "creator" ? "Decided by the newsletter's owner." : "Decided by the newsletter's rules.")}</p>}
			{comment.body && (
				<div className="mt-3 border-l-2 border-amber-500/40 pl-3 text-sm text-pretty text-foreground/80">
					<CommentBody paragraphs={parseCommentBody(comment.body)} />
				</div>
			)}
			<div className="mt-2 -ml-2 flex flex-wrap gap-x-1">
				{canEdit && (
					<button type="button" className="inline-flex h-9 items-center rounded-lg px-2 text-sm text-amber-950/80 hover:bg-amber-500/15 dark:text-amber-50/80" onClick={() => setMode(mode === "edit" ? null : "edit")}>
						Edit
					</button>
				)}
				<button type="button" className="inline-flex h-9 items-center rounded-lg px-2 text-sm text-amber-950/80 hover:bg-amber-500/15 dark:text-amber-50/80" onClick={() => setMode(mode === "delete" ? null : "delete")}>
					Delete
				</button>
			</div>
			{mode === "edit" && <FormEdit comment={comment} onDone={() => setMode(null)} />}
			{mode === "delete" && <FormDelete id={comment.id} onDone={() => setMode(null)} />}
		</li>
	);
}
