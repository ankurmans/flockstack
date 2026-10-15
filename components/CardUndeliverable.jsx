"use client";

import { useState, useTransition } from "react";
import { Loader2, Search, Trash2 } from "lucide-react";
import { findUndeliverableAddress, removeUndeliverableAddress } from "@/app/admin/actions";
import BadgeStatus from "@/components/BadgeStatus";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { formatDate, formatNumber } from "@/lib/format";
import { toast } from "@/lib/toast";

const REASONS = { bounce: "Hard bounce", trap: "Spam trap" };

// The never-email list every account shares (lib/global-suppressions.js): its size, an address looked up, and a wrong
// entry taken off.
export default function CardUndeliverable({ bounces, traps }) {
	const [email, setEmail] = useState("");
	const [result, setResult] = useState(null);
	const [isLooking, startLooking] = useTransition();

	function lookUp(event) {
		event.preventDefault();
		startLooking(async () => {
			const answer = await findUndeliverableAddress(email);
			if (answer?.error) return void toast.error(answer.error);
			setResult(answer);
		});
	}

	return (
		<div className="flex flex-col gap-4 rounded-xl bg-card p-4 shadow-border">
			<div className="flex min-w-0 flex-col gap-1">
				<p className="text-sm font-medium tabular-nums">
					{formatNumber(bounces)} hard {bounces === 1 ? "bounce" : "bounces"} · {formatNumber(traps)} spam {traps === 1 ? "trap" : "traps"}
				</p>
				<p className="text-xs text-pretty text-muted-foreground">
					Every account skips them in imports, signups and sends. Hard bounces stay 180 days, spam traps for good.
				</p>
			</div>
			<form onSubmit={lookUp} className="flex gap-2">
				<Input
					type="email"
					value={email}
					onChange={(event) => setEmail(event.target.value)}
					placeholder="Email, e.g. jane@example.com"
					aria-label="Email"
					required
					maxLength={320}
					autoComplete="off"
					spellCheck={false}
				/>
				<Button type="submit" variant="outline" disabled={isLooking} className="min-w-24">
					{isLooking ? <Loader2 className="animate-spin" /> : <Search data-icon="inline-start" />}
					Look up
				</Button>
			</form>
			{result && <ResultLookup result={result} onRemoved={() => setResult({ email: result.email, entry: null })} />}
		</div>
	);
}

function ResultLookup({ result, onRemoved }) {
	const [isConfirming, setIsConfirming] = useState(false);
	const [isRemoving, startRemoving] = useTransition();
	const { email, entry } = result;

	function remove() {
		startRemoving(async () => {
			const answer = await removeUndeliverableAddress(email);
			if (answer?.error) return void toast.error(answer.error);
			setIsConfirming(false);
			onRemoved();
			const restored = answer.restored > 0 && `${formatNumber(answer.restored)} ${answer.restored === 1 ? "contact is" : "contacts are"} active again`;
			toast.success("Removed from the list", restored ? { description: restored } : undefined);
		});
	}

	if (!entry) {
		return (
			<p className="text-sm text-muted-foreground">
				<span className="font-medium wrap-anywhere text-foreground">{email}</span> isn&apos;t on the list.
			</p>
		);
	}
	return (
		<div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/60 px-3 py-2.5 animate-fade-in">
			<div className="flex min-w-0 flex-col gap-1.5">
				<span className="text-sm font-medium wrap-anywhere">{email}</span>
				<span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground tabular-nums">
					<BadgeStatus status={entry.reason === "trap" ? "blocked" : "bounced"} label={REASONS[entry.reason]} />
					Since {formatDate(entry.listedAt)}
					{entry.detail && ` (${entry.detail})`}, {entry.expiresAt ? `leaves on ${formatDate(entry.expiresAt)}` : "for good"}
				</span>
			</div>
			<Button variant="destructive" size="sm" onClick={() => setIsConfirming(true)}>
				<Trash2 data-icon="inline-start" />
				Remove
			</Button>
			<Dialog open={isConfirming} onOpenChange={setIsConfirming}>
				<DialogContent className="sm:max-w-sm">
					<DialogHeader>
						<DialogTitle>Remove from the list?</DialogTitle>
						<DialogDescription>
							<span className="font-medium wrap-anywhere text-foreground">{email}</span> can be imported, added and sent to again
							on every account, and contacts the list stopped with it are active again.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<DialogClose asChild>
							<Button variant="outline">Cancel</Button>
						</DialogClose>
						<Button variant="destructive" onClick={remove} disabled={isRemoving} className="min-w-20">
							{isRemoving ? <Loader2 className="animate-spin" /> : "Remove"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
