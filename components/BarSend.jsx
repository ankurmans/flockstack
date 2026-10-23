"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Loader2, X } from "lucide-react";
import { listHeldSends, readProgress, sendCampaign, undoSend } from "@/app/(app)/campaigns/actions";
import { Button } from "@/components/ui/button";
import { formatCount } from "@/lib/format";
import { SEND_HELD_EVENT, SEND_STARTED_EVENT, getSecondsLeft } from "@/lib/send-hold-rules";
import { toast } from "@/lib/toast";

// Idle tabs look every so often for a send another tab or window held; a bar showing looks much more often, so Undo in one tab
// takes the bar away in the other.
const IDLE_POLL_MS = 20_000;
const ACTIVE_POLL_MS = 2500;
const TICK_MS = 250;
const CELEBRATION_MS = 9000;
const BAR_CLASS =
	"pointer-events-auto flex min-h-14 w-full max-w-120 items-center gap-2 rounded-2xl bg-foreground p-2 pl-4 text-background shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1),0_12px_32px_-8px_rgb(0_0_0/0.35),0_4px_8px_-4px_rgb(0_0_0/0.2)] animate-enter";

// The bar at the bottom of every dashboard page for a send. While one waits for its undo window (lib/send-hold.js): "Sending to
// 4,812 readers in 28 s", with Undo and Send now. It asks the server which sends are held, so it comes back on a reload and in a
// second tab; the countdown runs on the server's clock (the offset between it and the browser's), not the browser's. Once the
// send goes out: "Sent to 4,812 readers", for a few seconds, with the way to its results.
export default function BarSend() {
	const router = useRouter();
	const [holds, setHolds] = useState([]);
	const [celebrations, setCelebrations] = useState([]);
	const [now, setNow] = useState(() => Date.now());
	const [busyId, setBusyId] = useState(null);
	// How far the server's clock is ahead of the browser's, from the latest answer.
	const [offset, setOffset] = useState(0);
	// The sends the bar has shown, with the time each was due, to tell one that went out from one that was undone.
	const knownRef = useRef(new Map());

	const celebrate = useCallback((id, recipients) => {
		const key = `${id}-${Date.now()}`;
		setCelebrations((current) => [...current.filter((one) => one.id !== id), { id, key, recipients }]);
		setTimeout(() => setCelebrations((current) => current.filter((one) => one.key !== key)), CELEBRATION_MS);
	}, []);

	const refresh = useCallback(async () => {
		const result = await listHeldSends();
		if (result?.error) return;
		setOffset(new Date(result.now).getTime() - Date.now());
		const ids = new Set(result.holds.map(({ id }) => id));
		const gone = [...knownRef.current].filter(([id]) => !ids.has(id));
		knownRef.current = new Map(result.holds.map(({ id, sendAfter }) => [id, sendAfter]));
		setHolds(result.holds);
		if (gone.length === 0) return;
		// A send that was held a moment ago and isn't any more went out, or was undone elsewhere: the page under the bar changes
		// with it, and one whose time had come is celebrated, here too if another tab pressed Send now.
		router.refresh();
		for (const [id, sendAfter] of gone) {
			if (new Date(sendAfter).getTime() > new Date(result.now).getTime()) continue;
			const progress = await readProgress(id);
			if (!progress?.error && ["sending", "sent"].includes(progress.status)) celebrate(id, progress.counts.recipients);
		}
	}, [router, celebrate]);

	useEffect(() => {
		function onHeld(event) {
			const { id, subject, sendAfter, recipients, serverTime } = event.detail;
			setOffset(new Date(serverTime).getTime() - Date.now());
			knownRef.current.set(id, sendAfter);
			setHolds((current) => [...current.filter((hold) => hold.id !== id), { id, subject, sendAfter, recipients }]);
		}
		function onStarted(event) {
			celebrate(event.detail.id, event.detail.recipients);
		}
		window.addEventListener(SEND_HELD_EVENT, onHeld);
		window.addEventListener(SEND_STARTED_EVENT, onStarted);
		return () => {
			window.removeEventListener(SEND_HELD_EVENT, onHeld);
			window.removeEventListener(SEND_STARTED_EVENT, onStarted);
		};
	}, [celebrate]);

	const isHolding = holds.length > 0;

	useEffect(() => {
		if (!isHolding) return;
		const interval = setInterval(() => setNow(Date.now()), TICK_MS);
		return () => clearInterval(interval);
	}, [isHolding]);

	useEffect(() => {
		function look() {
			if (document.visibilityState === "visible") refresh();
		}
		// The first look is a moment after the page opens, off the render.
		const first = setTimeout(look, 0);
		const interval = setInterval(look, isHolding ? ACTIVE_POLL_MS : IDLE_POLL_MS);
		document.addEventListener("visibilitychange", look);
		return () => {
			clearTimeout(first);
			clearInterval(interval);
			document.removeEventListener("visibilitychange", look);
		};
	}, [isHolding, refresh]);

	function drop(id) {
		knownRef.current.delete(id);
		setHolds((current) => current.filter((hold) => hold.id !== id));
	}

	async function undo(hold) {
		setBusyId(hold.id);
		const result = await undoSend(hold.id);
		setBusyId(null);
		if (result?.error) {
			toast.error(result.error);
			await refresh();
		} else {
			drop(hold.id);
			toast.success("Back to a draft. Nothing was sent.");
		}
		router.refresh();
	}

	async function sendNow(hold) {
		setBusyId(hold.id);
		const result = await sendCampaign(hold.id);
		setBusyId(null);
		if (result?.error) {
			toast.error(result.error);
			await refresh();
		} else {
			drop(hold.id);
			celebrate(hold.id, hold.recipients);
		}
		router.refresh();
	}

	if (!isHolding && celebrations.length === 0) return null;

	// Above the editor's or a form's save bar while one shows (app/globals.css, the save-bar variant).
	return (
		<div className="pointer-events-none fixed right-(--dock-right) bottom-(--dock-bottom) left-4 z-40 flex flex-col items-center gap-2 save-bar:bottom-[calc(var(--dock-bottom)+4.25rem)] md:left-64">
			{celebrations.map((one) => (
				<RowSent key={one.key} recipients={one.recipients} campaignId={one.id} onClose={() => setCelebrations((current) => current.filter((item) => item.key !== one.key))} />
			))}
			{holds.map((hold) => (
				<RowHold key={hold.id} hold={hold} seconds={getSecondsLeft(hold.sendAfter, now, offset)} isBusy={busyId === hold.id} onUndo={() => undo(hold)} onSendNow={() => sendNow(hold)} />
			))}
		</div>
	);
}

export function RowHold({ hold, seconds, isBusy, onUndo, onSendNow }) {
	const isGoing = seconds === 0;
	return (
		<div data-send-bar className={BAR_CLASS}>
			<p title={hold.subject || undefined} className="min-w-0 flex-1 text-sm font-medium text-pretty tabular-nums">
				{isGoing ? (
					<span className="flex items-center gap-2">
						<Loader2 aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
						Sending to {formatCount(hold.recipients, "reader")}…
					</span>
				) : (
					<>
						Sending to {formatCount(hold.recipients, "reader")} in {seconds} s.
					</>
				)}
			</p>
			<span className="sr-only" role="status">
				{seconds > 0 && seconds % 10 === 0 ? `Sending in ${seconds} seconds. Undo is available.` : ""}
			</span>
			<div className="flex shrink-0 items-center gap-1">
				<Button type="button" size="lg" variant="ghost" disabled={isBusy || isGoing} onClick={onSendNow} className="px-3 text-background/70 hover:bg-background/10 hover:text-background dark:hover:bg-background/10">
					Send now
				</Button>
				<Button type="button" size="lg" disabled={isBusy} onClick={onUndo} className="bg-background text-foreground hover:bg-background/85">
					Undo
				</Button>
			</div>
		</div>
	);
}

// A web only issue has no readers: it says it was published.
export function RowSent({ recipients, campaignId, onClose }) {
	const pathname = usePathname();
	const isOnResults = pathname === `/campaigns/${campaignId}`;
	return (
		<div data-send-bar data-sent className={BAR_CLASS}>
			<span aria-hidden="true" className="relative grid size-6 shrink-0 place-items-center">
				<span className="absolute inset-0 rounded-full bg-emerald-400/50 motion-safe:animate-[celebrate-ring_900ms_ease-out_both]" />
				<svg viewBox="0 0 24 24" className="relative size-6" fill="none">
					<circle cx="12" cy="12" r="11" fill="#34d399" />
					<path
						d="M7 12.5l3.2 3.2L17 9"
						pathLength="1"
						stroke="#052e1f"
						strokeWidth="2.4"
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeDasharray="1"
						className="motion-safe:animate-[celebrate-check_450ms_150ms_cubic-bezier(0.2,0,0,1)_both]"
					/>
				</svg>
			</span>
			<p role="status" className="min-w-0 flex-1 text-sm font-medium text-pretty tabular-nums">
				{recipients > 0 ? `Sent to ${formatCount(recipients, "reader")}.` : "Published on your website."}
			</p>
			<div className="flex shrink-0 items-center gap-1">
				{!isOnResults && (
					<Button asChild size="lg" className="bg-background text-foreground hover:bg-background/85">
						<Link href={`/campaigns/${campaignId}`}>See results</Link>
					</Button>
				)}
				<Button type="button" size="icon" variant="ghost" aria-label="Close" onClick={onClose} className="text-background/70 hover:bg-background/10 hover:text-background dark:hover:bg-background/10">
					<X />
				</Button>
			</div>
		</div>
	);
}
