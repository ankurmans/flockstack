"use client";
import { useState, useTransition } from "react";
import { saveReplyRules } from "@/app/(app)/comments/actions";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

export default function FormReplyRules({ newsletter, settings, canEdit }) {
	const [enabled, setEnabled] = useState(settings.enabled);
	const [rules, setRules] = useState(settings.rules.map(rule => rule.text).join("\n"));
	const [learn, setLearn] = useState(settings.learnFromHides);
	const [consent, setConsent] = useState(false);
	const [result, setResult] = useState(null);
	const [pending, start] = useTransition();
	return <form onSubmit={event => {
		event.preventDefault();
		start(async () => setResult(await saveReplyRules({ newsletter, enabled, rules: rules.split("\n").map(text => text.trim()).filter(Boolean), learnFromHides: learn, consent })));
	}} className="rounded-xl bg-card p-4 shadow-border">
		<div className="flex items-center justify-between gap-3"><h2 className="text-sm font-medium">Reply Rules</h2><Switch aria-label="Reply Rules" checked={enabled} onCheckedChange={setEnabled} disabled={!canEdit || pending || !settings.available && !enabled} /></div>
		<p className="mt-2 text-sm text-muted-foreground">AI checks consenting readers&apos; comments against your public rules and optional recent examples. Clear violations can be hidden; uncertain or unavailable checks wait here. You can approve or reverse any decision. Existing hold-all or hold-links settings take priority.</p>
		<label htmlFor="reply-rules-text" className="mt-4 block text-sm font-medium">Public rules</label>
		<textarea id="reply-rules-text" value={rules} onChange={event => setRules(event.target.value)} rows={4} maxLength={2010} disabled={!canEdit || pending} className="mt-1 w-full rounded-lg border bg-background p-3 text-sm" aria-describedby="reply-rules-hint" />
		<p id="reply-rules-hint" className="mt-1 text-xs text-muted-foreground">One rule per line, up to 10 rules of 200 characters each. Readers see these words before posting.</p>
		<label className="mt-3 flex items-start gap-2 text-sm"><input type="checkbox" checked={learn} onChange={event => setLearn(event.target.checked)} disabled={!canEdit || pending} className="mt-1 size-4" /><span>Use recent consenting comments I manually hid as examples. Up to three comments from the last 30 days, at most 1,000 characters each; authors must still be active subscribers. AI decisions alone never become examples.</span></label>
		<label className="mt-3 flex items-start gap-2 text-sm"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} disabled={!canEdit || pending} className="mt-1 size-4" /><span>I agree to Cloudflare AI processing these rules, consenting comment text and eligible examples outside the account&apos;s storage region. Readers must agree separately. This uses the shared daily AI allowance; each started check counts, including failures. No model training.</span></label>
		{!settings.available && <p className="mt-3 text-sm text-muted-foreground">The server owner must configure Workers AI before enabling this.</p>}
		{canEdit ? <Button type="submit" disabled={pending || enabled && !consent} className="mt-4">{pending ? "Saving…" : "Save Reply Rules"}</Button> : <p className="mt-3 text-sm text-muted-foreground">Only the account owner can change Reply Rules.</p>}
		{result && <p role={result.error ? "alert" : "status"} className="mt-3 text-sm">{result.error ?? "Reply Rules saved."}</p>}
	</form>;
}
