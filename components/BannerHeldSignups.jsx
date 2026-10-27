"use client";

import { useState, useTransition } from "react";
import { Check, Loader2, X } from "lucide-react";
import { approveHeldSignups, rejectHeldSignups } from "@/app/(app)/contacts/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/lib/toast";

// People waiting for the owner's yes (lib/signup-approval.js): approve them all, or turn them all down. One at a time is in each
// held contact's menu. A long queue takes more than one press: the answer says how many are left.
export default function BannerHeldSignups({ newsletterId, count }) {
	const [isRejectOpen, setIsRejectOpen] = useState(false);
	const [isPending, startTransition] = useTransition();

	function approve() {
		startTransition(async () => {
			const result = await approveHeldSignups({ newsletterId, all: true });
			if (result?.error) return void toast.error(result.error);
			toast.success(result.remaining ? `${result.approved} approved. ${result.remaining} still waiting: press again.` : `${result.approved} approved`);
		});
	}

	function reject() {
		startTransition(async () => {
			const result = await rejectHeldSignups({ newsletterId, all: true });
			if (result?.error) return void toast.error(result.error);
			setIsRejectOpen(false);
			toast.success(result.remaining ? `${result.rejected} turned down. ${result.remaining} still waiting: press again.` : `${result.rejected} turned down`);
		});
	}

	return (
		<div role="status" className="flex flex-col gap-3 rounded-xl bg-muted/60 px-4 py-3 text-sm animate-enter sm:flex-row sm:items-center sm:justify-between">
			<p className="text-pretty">
				<span className="font-medium tabular-nums">{count}</span> {count === 1 ? "signup is" : "signups are"} waiting for your approval. They get nothing until you let them in.
			</p>
			<div className="flex shrink-0 gap-2">
				<Button size="sm" onClick={approve} disabled={isPending}>
					{isPending ? <Loader2 className="animate-spin" /> : <Check data-icon="inline-start" />}
					Approve all
				</Button>
				<Button size="sm" variant="outline" onClick={() => setIsRejectOpen(true)} disabled={isPending}>
					<X data-icon="inline-start" />
					Turn down all
				</Button>
			</div>
			<Dialog open={isRejectOpen} onOpenChange={setIsRejectOpen}>
				<DialogContent className="sm:max-w-sm">
					<DialogHeader>
						<DialogTitle>Turn down every held signup?</DialogTitle>
						<DialogDescription>They are deleted and not emailed. They can ask to join again.</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<DialogClose asChild>
							<Button variant="outline">Cancel</Button>
						</DialogClose>
						<Button variant="destructive" onClick={reject} disabled={isPending} className="min-w-20">
							{isPending ? <Loader2 className="animate-spin" /> : "Turn down"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
