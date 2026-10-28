"use client";
import { MessageSquare } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import * as Y from "yjs";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import { absolutePositionToRelativePosition, relativePositionToAbsolutePosition, ySyncPluginKey } from "@tiptap/y-tiptap";
import { connectCampaign, readThreads, addThread, replyThread, resolveThread, removeThread } from "@/app/(app)/campaigns/[id]/collaborate/actions";
import EditorRich from "@/components/EditorRich";
import StateEmpty from "@/components/StateEmpty";
import { CampaignCollaborationProvider } from "@/lib/collaboration-provider";
const position = value => btoa(String.fromCharCode(...Y.encodeRelativePosition(value)));

export default function CollaborativeCampaign({ id, newsletterId, collaborators, viewerId, editorOptions }) {
	const router = useRouter(), providerRef = useRef(null), [editorInstance, setEditorInstance] = useState(null), [view, setView] = useState({ status: "connecting", role: "viewer", members: [], subject: "", previewText: "" }), [html, setHtml] = useState(""), [selection, setSelection] = useState(null), [threads, setThreads] = useState([]), [nextCursor, setNextCursor] = useState(null), [error, setError] = useState(null), [working, setWorking] = useState(false);
	const refreshThreads = useCallback(async () => { const result = await readThreads(id); if (result.error) setError(result.error); else { setThreads(result.threads); setNextCursor(result.nextCursor); } }, [id]);
	useEffect(() => {
		const provider = new CampaignCollaborationProvider(() => connectCampaign(id)); providerRef.current = provider;
		provider.onThreadsChanged = refreshThreads; provider.onReady = refreshThreads;
		const unsubscribe = provider.subscribe(current => setView({ status: current.status, error: current.error, role: current.role ?? "viewer", epoch: current.epoch, subject: current.doc.getText("subject").toString(), previewText: current.doc.getText("previewText").toString(), provider: current, members: [...current.awareness.getStates().values()].map(state => state.user).filter(Boolean), user: current.user }));
		const beforeLeave = event => { if (provider.dirty) { event.preventDefault(); event.returnValue = ""; } };
		window.addEventListener("beforeunload", beforeLeave); provider.connect();
		return () => { window.removeEventListener("beforeunload", beforeLeave); unsubscribe(); provider.onReady = null; provider.onThreadsChanged = null; void provider.disposeAfterFlush(); providerRef.current = null; };
	}, [id, refreshThreads]);
	const writable = view.role !== "viewer" && !["conflict", "unavailable"].includes(view.status);
	const collaboration = useMemo(() => {
		const provider = view.provider;
		if (!provider || !view.epoch) return null;
		return { document: provider.doc, provider, user: view.user, editable: writable, onEditor: setEditorInstance, extensions: [Collaboration.configure({ document: provider.doc, field: "default" }), CollaborationCaret.configure({ provider, user: view.user })], onSelection: editor => {
			const { from, to } = editor.state.selection, state = ySyncPluginKey.getState(editor.state);
			if (from === to || !state?.binding) { setSelection(null); return; }
			setSelection({ start: position(absolutePositionToRelativePosition(from, state.type, state.binding.mapping)), end: position(absolutePositionToRelativePosition(to, state.type, state.binding.mapping)), quote: editor.state.doc.textBetween(from, to, " ").slice(0, 500) });
		} };
	}, [view.epoch, view.user, view.provider, writable]);
	async function perform(operation) { setWorking(true); setError(null); try { const result = await operation(); if (result?.error) { setError(result.error); return false; } else { await refreshThreads(); return true; } } catch { setError("The private discussion could not be updated. Refresh before retrying."); return false; } finally { setWorking(false); } }
	function showAnchor(anchor) {
		const editor = editorInstance, provider = providerRef.current;
		if (!editor || !provider) return;
		try {
			const state = ySyncPluginKey.getState(editor.state), decode = value => Y.decodeRelativePosition(Uint8Array.from(atob(value), char => char.charCodeAt(0)));
			const from = relativePositionToAbsolutePosition(provider.doc, state.type, decode(anchor.start), state.binding.mapping), to = relativePositionToAbsolutePosition(provider.doc, state.type, decode(anchor.end), state.binding.mapping);
			if (from === null || to === null) throw new Error();
			editor.commands.setTextSelection({ from, to }); editor.commands.focus(); editor.commands.scrollIntoView();
		} catch { setError("This selected text is no longer available. The original quote is kept with the discussion."); }
	}
	async function moreThreads() { const result = await readThreads(id, nextCursor); if (result.error) setError(result.error); else { setThreads(current => [...current, ...result.threads.filter(thread => !current.some(row => row.id === thread.id))]); setNextCursor(result.nextCursor); } }

	async function leave() { if (html.includes('src="blob:')) { setError("Wait for images to finish uploading before leaving the shared editor."); return; } if (await providerRef.current?.flush()) router.push(`/campaigns/${id}`); else setError("Changes are not yet confirmed. Keep a copy before leaving."); }
	return <div className="space-y-4"><div className="flex flex-wrap items-center justify-between gap-3 text-sm"><p role="status">{view.status === "saved" ? "All shared changes saved" : view.status === "saving" ? "Saving shared changes…" : view.status === "offline" ? "Offline — local changes have not been confirmed" : view.status === "connecting" ? "Connecting…" : "Editing stopped"}</p><button onClick={leave} className="rounded border px-3 py-2">Save and return to issue</button></div>{(error || view.error) && <p role="alert" className="rounded border p-3">{error || view.error}</p>}<p className="text-sm text-muted-foreground">{view.members.map((member, index) => <span key={index} className="mr-3" style={{ color: member.color }}>{member.name}</span>)}{view.role === "viewer" ? "You can read this shared draft." : "Edits merge live. Outside edits and send transitions stop this session."}</p>
		<div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]"><section className="space-y-4"><label className="block text-sm">Subject<input className="mt-1 block w-full rounded border bg-background p-3" maxLength={200} value={view.subject} disabled={!writable || !view.epoch} onChange={event => providerRef.current?.replaceText("subject", event.target.value)} /></label><label className="block text-sm">Preview text<input className="mt-1 block w-full rounded border bg-background p-3" maxLength={300} value={view.previewText} disabled={!writable || !view.epoch} onChange={event => providerRef.current?.replaceText("previewText", event.target.value)} /></label>{collaboration && <fieldset disabled={!writable} className="rounded-xl border"><EditorRich {...editorOptions} collaboration={collaboration} onChange={setHtml} newsletterId={newsletterId} campaignId={id} /></fieldset>}<details><summary className="cursor-pointer text-sm">Keep a local copy</summary><p className="mt-2 text-sm">Copy this text before reloading if changes are unconfirmed.</p><textarea readOnly value={`${view.subject}\n${view.previewText}\n${html}`} className="mt-2 h-48 w-full rounded border bg-background p-3 font-mono text-xs" /></details></section>
		<aside className="space-y-4 rounded-xl border p-4"><div className="flex justify-between gap-3"><h2 className="font-semibold">Private editor discussion</h2><button onClick={refreshThreads} className="text-sm underline">Refresh</button></div><p className="text-xs text-muted-foreground">Only your team and authorized creator tools can read this. It never appears in the issue or reader comments. Mentions send no email.</p>{writable && view.epoch && <CommentForm key={selection?.start ?? "unanchored"} collaborators={collaborators} disabled={working} label="Add private comment" quote={selection?.quote} submit={fields => perform(async () => { if (!await providerRef.current.flush()) return { error: "Wait for the draft checkpoint before commenting." }; return addThread({ id, epoch: view.epoch, anchor: selection, ...fields }); })} />}
			{threads.length === 0 && <StateEmpty isCompact className="px-0" icon={MessageSquare} title="No private comments yet" />}{threads.map(thread => <article key={thread.id} className="space-y-3 border-t pt-4 text-sm"><p className="font-medium">{thread.authorName}{thread.mentionedYou ? " · Mentioned you" : ""}{thread.resolvedAt ? " · Resolved" : ""}</p>{thread.anchor?.quote && <blockquote className="border-l-2 pl-3 text-xs text-muted-foreground">{thread.anchor.quote}{thread.outdated ? " · Earlier document version" : <button className="ml-2 underline" onClick={() => showAnchor(thread.anchor)}>Show selected text</button>}</blockquote>}<p className="whitespace-pre-wrap">{thread.removedAt ? "Thread removed" : thread.body}</p>{thread.mentions.length > 0 && <p className="text-xs text-muted-foreground">{thread.mentions.map(mention => `@${collaborators.find(member => member.id === mention)?.name ?? "Former collaborator"}`).join(" ")}</p>}{thread.replies.map(reply => <div key={reply.id} className="ml-3 border-l pl-3"><p>{reply.authorName}{reply.mentionedYou ? " · Mentioned you" : ""}</p><p className="whitespace-pre-wrap">{reply.body}</p></div>)}{writable && !thread.removedAt && <><CommentForm collaborators={collaborators} disabled={working} label="Reply privately" submit={fields => perform(() => replyThread({ id: thread.id, ...fields }))} /><div className="flex gap-3 text-xs"><button disabled={working} className="underline" onClick={() => perform(() => resolveThread({ id: thread.id, resolved: !thread.resolvedAt }))}>{thread.resolvedAt ? "Reopen" : "Resolve"}</button>{(view.role === "owner" || view.role === "admin" && thread.authorId === viewerId) && <button disabled={working} className="underline" onClick={() => { if (window.confirm("Remove this private thread and its replies?")) perform(() => removeThread({ id: thread.id })); }}>Remove thread</button>}</div></>}</article>)}
			{nextCursor && <button className="text-sm underline" onClick={moreThreads}>More private threads</button>}
		</aside></div>
	</div>;
}
function CommentForm({ collaborators, disabled, label, quote, submit }) {
	const [externalId, setExternalId] = useState(() => crypto.randomUUID());
	return <form className="space-y-2" onSubmit={async event => { event.preventDefault(); const form = event.currentTarget, fields = new FormData(form); if (await submit({ externalId, body: String(fields.get("body")), mentions: fields.getAll("mentions").map(String) })) { setExternalId(crypto.randomUUID()); form.reset(); } }}>
		{quote && <p className="line-clamp-3 border-l-2 pl-2 text-xs">Selected: {quote}</p>}<textarea aria-label={label} name="body" maxLength={2000} required disabled={disabled} rows={3} className="w-full rounded border bg-background p-2 text-sm" /><label className="block text-xs">Mention collaborators (optional)<select multiple name="mentions" disabled={disabled} className="mt-1 w-full rounded border bg-background p-1">{collaborators.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label><button disabled={disabled} className="rounded border px-3 py-2 text-xs">{label}</button>
	</form>;
}
