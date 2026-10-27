"use client";

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { askAccountAssistant, createAssistantGrant } from "@/app/(app)/assistant/actions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

const LEVELS = { read_only: "Read only", drafts: "Write drafts", send_with_approval: "Sends with approval" };

export default function PanelAccountAssistant({ newsletterId, settings }) {
	const [grants, setGrants] = useState(settings.grants);
	const [grant, setGrant] = useState(settings.grants[0]?.id ?? "");
	const [level, setLevel] = useState("drafts");
	const [consent, setConsent] = useState(false);
	const [body, setBody] = useState("");
	const [messages, setMessages] = useState([]);
	const [usage, setUsage] = useState(settings.usage);
	const [error, setError] = useState("");
	const [pending, start] = useTransition();
	const retry = useRef(null);
	function create() {
		start(async () => {
			setError("");
			try {
				const result = await createAssistantGrant(newsletterId, level);
				if (result.error) setError(result.error);
				else { setGrants((rows) => [result.grant, ...rows]); setGrant(result.grant.id); }
			} catch { setError("Couldn't create the grant. Check API keys before retrying."); }
		});
	}
	function send(event) {
		event.preventDefault();
		const request = body.trim();
		if (!request || !consent || !grant || pending) return;
		start(async () => {
			setError("");
			if (retry.current?.body !== request || retry.current?.grant !== grant) retry.current = { body: request, grant, turnId: crypto.randomUUID() };
			try {
				const history = messages.slice(-10).map(({ role, content }) => ({ role, content: content.slice(0, 4000) }));
				const result = await askAccountAssistant({ newsletter: newsletterId, ...retry.current, consent, history });
				if (result.error) { setError(result.error); return; }
				setMessages((rows) => [...rows, { role: "user", content: request }, { role: "assistant", content: result.text, results: result.results, stopped: result.stopped }].slice(-12));
				setUsage(result.usage); setBody(""); retry.current = null;
			} catch { setError("The response was interrupted. Check agent activity and approvals before retrying; some tools may have completed."); }
		});
	}
	return <div className="max-w-3xl space-y-6">
		<section className="space-y-3 rounded-xl border p-4" aria-label="Assistant access">
			<h2 className="font-medium">Assistant access</h2>
			<p className="text-sm text-muted-foreground">Each grant is limited to this newsletter, expires in 90 days and allows up to 100 tool calls a day. Revoke it on <Link href="/api-keys" className="underline">API keys</Link>. Full access is unavailable.</p>
			<div className="flex flex-wrap items-center gap-3">
				<label className="space-x-2 text-sm">New access<select value={level} onChange={(event) => setLevel(event.target.value)} disabled={pending} className="rounded-md border p-2">{Object.entries(LEVELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
				<Button type="button" variant="outline" onClick={create} disabled={pending}>Create grant</Button>
			</div>
			{grants.length > 0 && <label className="block space-y-2 text-sm">Active grant<select className="block w-full rounded-md border p-2" value={grant} onChange={(event) => { setGrant(event.target.value); setMessages([]); }} disabled={pending}>{grants.map((row) => <option value={row.id} key={row.id}>{LEVELS[row.level]} · {row.id.slice(-6)} · expires {row.expiresAt.slice(0, 10)}</option>)}</select></label>}
		</section>
		<p className="text-sm text-muted-foreground">{usage.used} shared AI requests used today{usage.limit === null ? "." : ` of ${usage.limit}.`} Each started model call counts, including failures; up to three model calls and four tool attempts per request.</p>
		{!settings.available && <p role="status">Workers AI is not available on this server.</p>}
		<div className="space-y-4" aria-live="polite" aria-busy={pending}>
			{messages.map((message, index) => <article key={index} className="space-y-3 rounded-xl border p-4">
				<p className="text-xs font-medium text-muted-foreground">{message.role === "user" ? "You" : "Account assistant"}</p><p className="whitespace-pre-wrap text-sm">{message.content}</p>
				{message.stopped && <p className="text-xs text-muted-foreground">{message.stopped}</p>}
				{message.results?.map((result, i) => <Result key={i} result={result} />)}
			</article>)}
		</div>
		<form onSubmit={send} className="space-y-3">
			<label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} required disabled={pending} className="mt-1" /><span>Send this conversation and any selected private brief, authored draft or allowed tool result to Cloudflare Workers AI. Processing may occur outside my region. Don’t include secrets or private contact data. The conversation stays in this tab; drafts, plans, agent activity and approval requests follow their ordinary retention.</span></label>
			<label className="block space-y-2 text-sm">Your request<Textarea required maxLength={4000} value={body} onChange={(event) => setBody(event.target.value)} disabled={pending || !settings.available} placeholder="Draft an issue from my brief, or plan next week’s posts" /></label>
			{error && <p role="alert" className="text-sm text-destructive">{error}</p>}
			<div className="flex gap-3"><Button type="submit" disabled={pending || !settings.available || !consent || !grant || !body.trim()}>{pending ? "Working…" : "Ask assistant"}</Button><Button type="button" variant="ghost" disabled={pending} onClick={() => { setMessages([]); setBody(""); retry.current = null; }}>Clear conversation</Button></div>
		</form>
		<p className="text-xs text-muted-foreground">Model prose can be wrong. Tool cards record actual results. A completed draft or plan is not a delivery. Review <Link href="/agent-activity" className="underline">agent activity</Link> and <Link href="/approvals" className="underline">approvals</Link> before retrying an interrupted request. Clearing this conversation does not undo tools already run.</p>
	</div>;
}

function Result({ result }) {
	const data = result.data;
	const id = data.id ?? data.item?.id;
	const path = result.status === "approval_required" ? "/approvals" : /^[a-f0-9]{24}$/.test(id ?? "") ? result.tool.includes("campaign") ? `/campaigns/${id}` : result.tool === "create_content_item" ? "/campaigns/calendar" : result.tool === "create_segment" ? "/segments" : null : null;
	return <div className="rounded-lg bg-muted p-3 text-sm"><p className="font-medium">{result.tool.replaceAll("_", " ")} · {result.status.replaceAll("_", " ")}{result.reused ? " · reused" : ""}</p><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(data, null, 2)}</pre>{path && <Link className="mt-2 inline-block underline" href={path}>Review result</Link>}</div>;
}
