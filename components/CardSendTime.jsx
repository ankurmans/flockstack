"use client";
import { useState, useTransition } from "react";
import { findSendTime } from "@/app/(app)/campaigns/send-time-actions";
export default function CardSendTime({ newsletterId }) {
	const [result, setResult] = useState(null);
	const [pending, start] = useTransition();
	return <details className="my-4 rounded-lg border p-4"><summary className="cursor-pointer text-sm font-medium">Find a send time from past results</summary><p className="mt-2 text-sm text-muted-foreground">Uses this newsletter’s last 90 days. At least three completed campaigns and 100 sends in one weekday and hour. Opens may include privacy proxies.</p><button type="button" disabled={pending} className="mt-3 rounded-md border px-3 py-2 text-sm" onClick={() => start(async () => setResult(await findSendTime(newsletterId, Intl.DateTimeFormat().resolvedOptions().timeZone)))}>{pending ? "Checking…" : "Check past sends"}</button>{result?.failure && <p role="alert" className="mt-3 text-sm">{result.failure.message}</p>}{result?.output && <p role="status" className="mt-3 text-sm">{result.output.suggestedAt ? `Suggested: ${new Date(result.output.suggestedAt).toLocaleString()} (${result.output.timeZone}). Choose this time in Schedule if it fits your plan.` : "There isn’t enough history to suggest a time yet."} Nothing has been scheduled.</p>}</details>;
}
