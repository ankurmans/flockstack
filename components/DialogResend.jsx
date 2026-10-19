"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Repeat } from "lucide-react";
import { resendCampaign } from "@/app/(app)/campaigns/actions";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RESEND_DELAY_HOURS } from "@/lib/resend-rules";
import { formatCount } from "@/lib/format";
import { toast } from "@/lib/toast";
import { useToastError } from "@/lib/use-toast-error";
import { cn } from "@/lib/utils";

// The datetime-local field's value for a date, in the browser's time zone.
function toLocalInput(date) {
	const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
	return local.toISOString().slice(0, 16);
}

function getDefaultTime(sentAt) {
	const later = new Date(sentAt).getTime() + RESEND_DELAY_HOURS * 3_600_000;
	return new Date(Math.max(later, Date.now() + 10 * 60_000));
}

// Send a sent campaign again to the readers who didn't open it, or didn't click, with a new subject.
export default function DialogResend({ campaignId, subject, sentAt, counts }) {
	const router = useRouter();
	const toastError = useToastError();
	const [isOpen, setIsOpen] = useState(false);
	const [to, setTo] = useState("unopened");
	const [newSubject, setNewSubject] = useState("");
	const [when, setWhen] = useState("");
	const [isSending, startSending] = useTransition();
	const count = counts[to] ?? 0;

	function changeOpen(nextIsOpen) {
		if (nextIsOpen && !when) setWhen(toLocalInput(getDefaultTime(sentAt)));
		setIsOpen(nextIsOpen);
	}

	function schedule() {
		startSending(async () => {
			const result = await resendCampaign(campaignId, { subject: newSubject, to, scheduledAt: new Date(when).toISOString() });
			if (result?.error) return toastError(result);
			setIsOpen(false);
			toast.success("Resend scheduled");
			router.push(`/campaigns/${result.id}`);
		});
	}

	return (
		<Dialog open={isOpen} onOpenChange={changeOpen}>
			<DialogTrigger asChild>
				<Button variant="outline">
					<Repeat data-icon="inline-start" />
					Send again
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Send again to readers who missed it</DialogTitle>
					<DialogDescription className="tabular-nums">
						Up to {formatCount(count, "reader")}, with a new subject. People who unsubscribed, bounced or complained since are left out. One resend per campaign.
					</DialogDescription>
				</DialogHeader>
				<div role="radiogroup" aria-label="Who gets it" className="flex flex-wrap gap-1.5">
					{[
						{ value: "unopened", label: "Didn't open" },
						{ value: "unclicked", label: "Didn't click" },
					].map(({ value, label }) => (
						<button
							key={value}
							type="button"
							role="radio"
							aria-checked={to === value}
							onClick={() => setTo(value)}
							className={cn(
								"h-7 rounded-full px-3 text-xs font-medium outline-none transition-[background-color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-ring",
								to === value ? "bg-foreground text-background" : "text-muted-foreground shadow-border hover:bg-muted/60 hover:text-foreground"
							)}
						>
							{label}
						</button>
					))}
				</div>
				<div className="flex flex-col gap-2">
					<Label htmlFor="resend-subject">New subject</Label>
					<Input id="resend-subject" value={newSubject} onChange={(event) => setNewSubject(event.target.value)} placeholder={subject} maxLength={200} />
				</div>
				<div className="flex flex-col gap-2">
					<Label htmlFor="resend-when">When</Label>
					<Input id="resend-when" type="datetime-local" value={when} onChange={(event) => setWhen(event.target.value)} />
					<span className="text-xs text-muted-foreground">{RESEND_DELAY_HOURS} hours after the first send gives everyone a fair chance to open it.</span>
				</div>
				<DialogFooter>
					<DialogClose asChild>
						<Button variant="outline">Cancel</Button>
					</DialogClose>
					<Button onClick={schedule} disabled={isSending || !newSubject.trim() || !when || count === 0} className="min-w-24">
						{isSending ? <Loader2 className="animate-spin" /> : "Schedule"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
