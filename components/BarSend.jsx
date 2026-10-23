"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { listHeldSends, sendCampaign, undoSend } from "@/app/(app)/campaigns/actions";
import { Button } from "@/components/ui/button";
import { formatCount } from "@/lib/format";
import { SEND_HELD_EVENT, getSecondsLeft } from "@/lib/send-hold-rules";
import { toast } from "@/lib/toast";

// Idle tabs look every so often for a send another tab or window held; a bar showing looks much more often, so Undo in one tab
// takes the bar away in the other.
const IDLE_POLL_MS = 20_000;
const ACTIVE_POLL_MS = 2500;
const TICK_MS = 250;

// The bar at the bottom of every dashboard page while a send waits for its undo window (lib/send-hold.js): "Sending to 4,812
// readers in 28 s", with Undo and Send now. It asks the server which sends are held, so it comes back on a reload and in a
// second tab; the countdown runs on the server's clock (the offset between it and the browser's), not the browser's.
export default function BarSend() {
	const router = useRouter();
	const [holds, setHolds] = useState([]);
	const [now, setNow] = useState(() => Date.now());
	const [busyId, setBusyId] = useState(null);
	// How far the server's clock is ahead of the browser's, from the latest answer.
	const [offset, setOffset] = useState(0);
	const knownRef = useRef(new Set());

	const refresh = useCallback(async () => {
		const result = await listHeldSends();
		if (result?.error) return;
		setOffset(new Date(result.now).getTime() - Date.now());
		// A send that was held a moment ago and isn't any more went out, or was undone elsewhere: the page under the bar changes with it.
		const ids = new Set(result.holds.map(({ id }) => id));
		if ([...knownRef.current].some((id) => !ids.has(id))) router.refresh();
		knownRef.current = ids;
		setHolds(result.holds);
	}, [router]);

	useEffect(() => {
		function onHeld(event) {
			const { id, subject, sendAfter, recipients, serverTime } = event.detail;
			setOffset(new Date(serverTime).getTime() - Date.now());
			knownRef.current.add(id);
			setHolds((current) => [...current.filter((hold) => hold.id !== id), { id, subject, sendAfter, recipients }]);
		}
		window.addEventListener(SEND_HELD_EVENT, onHeld);
		return () => window.removeEventListener(SEND_HELD_EVENT, onHeld);
	}, []);

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
		}
		router.refresh();
	}

	if (!isHolding) return null;

	return (
		<div className="pointer-events-none fixed right-(--dock-right) bottom-(--dock-bottom) left-4 z-40 flex flex-col items-center gap-2 md:left-64">
			{holds.map((hold) => (
				<RowHold key={hold.id} hold={hold} seconds={getSecondsLeft(hold.sendAfter, now, offset)} isBusy={busyId === hold.id} onUndo={() => undo(hold)} onSendNow={() => sendNow(hold)} />
			))}
		</div>
	);
}

function RowHold({ hold, seconds, isBusy, onUndo, onSendNow }) {
	const isGoing = seconds === 0;
	return (
		<div
			data-send-bar
			className="pointer-events-auto flex min-h-14 w-full max-w-120 items-center gap-2 rounded-2xl bg-foreground p-2 pl-4 text-background shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1),0_12px_32px_-8px_rgb(0_0_0/0.35),0_4px_8px_-4px_rgb(0_0_0/0.2)] animate-enter"
		>
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
