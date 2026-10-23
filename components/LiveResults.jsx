"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { readProgress } from "@/app/(app)/campaigns/actions";
import CardStat from "@/components/CardStat";
import { LIMITS } from "@/lib/config";
import { formatNumber, formatRate } from "@/lib/format";
import { rateTone } from "@/lib/health";
import { cn } from "@/lib/utils";

const LIVE_POLL_MS = 3000;
// After the last email went out the delivery and open counts keep arriving for a while: asked for slowly, then left alone.
const SETTLING_POLL_MS = 10_000;
const SETTLING_POLLS = 12;

// The numbers at the top of a campaign's page. While the send runs they follow it: asked for every few seconds, the bar and
// the six counters moving as emails go out, then every ten seconds for a couple of minutes while the last deliveries
// arrive, then left alone. `initial` is what the server saw (the campaign's status and stats, and whether it is worth watching: it
// is going out or went out in the last few minutes); children are the notes under
// the bar that only the server knows.
export default function LiveResults({ campaignId, initial, children }) {
	const router = useRouter();
	const [progress, setProgress] = useState(initial);
	const [settled, setSettled] = useState(0);
	const [wasLive, setWasLive] = useState(initial.isLive);
	const isWatching = initial.watch && (progress.isLive || settled < SETTLING_POLLS);
	const { status, counts } = progress;

	const look = useCallback(async () => {
		if (document.visibilityState !== "visible") return;
		const result = await readProgress(campaignId);
		if (result?.error) return;
		setProgress(result);
		if (result.isLive) return setWasLive(true);
		setSettled((current) => current + 1);
		if (wasLive) {
			// It finished while the page watched: the rest of the page (inboxes, links) is read again.
			setWasLive(false);
			router.refresh();
		}
	}, [campaignId, router, wasLive]);

	useEffect(() => {
		if (!isWatching) return;
		const interval = setInterval(look, progress.isLive ? LIVE_POLL_MS : SETTLING_POLL_MS);
		return () => clearInterval(interval);
	}, [isWatching, progress.isLive, look]);

	const reached = counts.delivered || counts.sent;
	const share = counts.recipients ? Math.min(counts.sent / counts.recipients, 1) : 0;
	const showsBar = ["held", "sending", "paused"].includes(status) || (initial.watch && status === "sent");

	return (
		<>
			{showsBar && (
				<div className="flex flex-col gap-2 animate-enter">
					<div className="flex items-center justify-between gap-3 text-sm tabular-nums">
						<span className="flex items-center gap-2 text-muted-foreground">
							{formatNumber(counts.sent)} of {formatNumber(counts.recipients)}
							{status === "sending" && (
								<span className="inline-flex items-center gap-1.5 text-xs">
									<span aria-hidden="true" className="size-1.5 rounded-full bg-emerald-500 motion-safe:animate-pulse" />
									Live
								</span>
							)}
							{status === "sent" && (
								<span className="inline-flex items-center gap-1 text-xs">
									<Check aria-hidden="true" className="size-3.5 text-emerald-500" />
									Done
								</span>
							)}
						</span>
						<span>{Math.round(share * 100)}%</span>
					</div>
					<div
						role="progressbar"
						aria-label="Emails sent"
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={Math.round(share * 100)}
						className="h-1.5 overflow-hidden rounded-full bg-muted"
					>
						<div className={cn("h-full rounded-full bg-foreground transition-[width] duration-500 motion-reduce:transition-none")} style={{ width: `${share * 100}%` }} />
					</div>
					{children}
				</div>
			)}

			<div aria-live={status === "sending" ? "off" : undefined} style={{ "--stagger": 1 }} className="grid grid-cols-2 gap-3 animate-enter sm:grid-cols-3 lg:grid-cols-6">
				<CardStat label="Delivered" value={formatRate(counts.delivered, counts.sent)} detail={formatNumber(counts.delivered)} />
				<CardStat label="Opened" value={formatRate(counts.opened, reached)} detail={formatNumber(counts.opened)} />
				<CardStat label="Clicked" value={formatRate(counts.clicked, reached)} detail={formatNumber(counts.clicked)} />
				<CardStat label="Bounced" value={formatRate(counts.bounced, counts.sent, 2)} detail={formatNumber(counts.bounced)} tone={rateTone(counts.bounced, counts.sent, LIMITS.pause.bounceRate)} />
				<CardStat label="Complaints" value={formatRate(counts.complained, counts.sent, 3)} detail={formatNumber(counts.complained)} tone={rateTone(counts.complained, counts.sent, LIMITS.pause.complaintRate)} />
				<CardStat label="Unsubscribed" value={formatRate(counts.unsubscribed, reached, 2)} detail={formatNumber(counts.unsubscribed)} />
			</div>
		</>
	);
}
