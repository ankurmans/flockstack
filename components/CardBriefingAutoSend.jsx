"use client";

import { useState, useTransition } from "react";
import { setBriefingAutoSend } from "@/app/(app)/briefings/actions";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";

// "Sending by itself" for a briefing. Dashboard only: no API key or connected app can turn it on. Turning it on asks for a tick that
// the owner understands issues go out with nobody reading them first.
export default function CardBriefingAutoSend({ briefingId, isOn, dailyCap, maxDailyCap, isFree, askBeforeAgentSends }) {
	const [confirmed, setConfirmed] = useState(false);
	const [cap, setCap] = useState(String(dailyCap ?? 1));
	const [isPending, startTransition] = useTransition();

	function change(enabled) {
		startTransition(async () => {
			const result = await setBriefingAutoSend(briefingId, { enabled, confirm: confirmed, dailyCap: cap });
			if (result?.error) toast.error(result.error);
			else {
				setConfirmed(false);
				toast.success(enabled ? "This briefing sends by itself when every check passes" : "Every issue waits as a draft again");
			}
		});
	}

	return (
		<section className="flex flex-col gap-3 rounded-xl bg-card p-4 shadow-border animate-enter sm:p-5">
			<div>
				<h2 className="font-semibold tracking-tight">Sending by itself</h2>
				<p className="mt-1 max-w-xl text-sm text-pretty text-muted-foreground">
					{isOn
						? "Each scheduled run that passes every check is sent to your whole audience with nobody reading it first. Anything that fails a check, a thin run or one started by hand stays a draft, and the note you get says why. You are emailed after each send, with a link to pause."
						: "Today every issue waits as a draft for you. Turn this on and a scheduled run that passes every check, including the claim check, is sent to your audience by itself."}
				</p>
				{askBeforeAgentSends && <p className="mt-1 max-w-xl text-sm text-pretty text-muted-foreground">This newsletter asks before an agent sends, so each send waits for you on the Approvals page.</p>}
			</div>
			{isFree ? (
				<p className="text-sm text-muted-foreground">The Free plan keeps a briefing&apos;s issues as drafts. A paid plan can send them by itself.</p>
			) : isOn ? (
				<div className="flex items-center justify-between gap-3">
					<span className="text-sm text-muted-foreground">On: up to {dailyCap} {dailyCap === 1 ? "issue" : "issues"} a day.</span>
					<Button type="button" variant="outline" disabled={isPending} onClick={() => change(false)}>
						Turn off
					</Button>
				</div>
			) : (
				<div className="flex flex-col gap-3">
					<label className="flex items-start gap-2 text-sm">
						<input type="checkbox" className="mt-0.5" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
						<span>I understand that issues will be sent to my whole audience without me reading them first, and that a send can&apos;t be taken back.</span>
					</label>
					<label className="flex items-center gap-2 text-sm">
						<span className="text-muted-foreground">Issues a day, at most</span>
						<select value={cap} onChange={(event) => setCap(event.target.value)} className="rounded-md bg-background px-2 py-1 shadow-border">
							{Array.from({ length: maxDailyCap }, (_, index) => index + 1).map((count) => (
								<option key={count} value={count}>
									{count}
								</option>
							))}
						</select>
					</label>
					<div>
						<Button type="button" disabled={!confirmed || isPending} onClick={() => change(true)}>
							Turn on sending by itself
						</Button>
					</div>
				</div>
			)}
		</section>
	);
}
