"use client";

import { useState, useTransition } from "react";
import { saveSentWithLink } from "@/app/(account)/billing/actions";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/lib/toast";

// A paid plan's choice on the billing page: the small "Sent with FlockStack" link under the footer of its emails and on
// its websites, off unless turned on. The Free plan always carries it, so this card is for paid plans only.
export default function CardSentWith({ enabled }) {
	const [isOn, setIsOn] = useState(enabled);
	const [isPending, startTransition] = useTransition();

	function change(next) {
		setIsOn(next);
		startTransition(async () => {
			const result = await saveSentWithLink(next);
			if (result?.error) {
				setIsOn(!next);
				toast.error(result.error);
			} else toast.success(next ? "The link is on" : "The link is off");
		});
	}

	return (
		<div className="flex items-start justify-between gap-4 rounded-xl bg-card p-4 shadow-border sm:p-5">
			<div className="flex flex-col gap-1">
				<label htmlFor="sent-with-link" className="text-sm font-medium">
					Show &ldquo;Sent with FlockStack&rdquo;
				</label>
				<p className="max-w-xl text-sm text-pretty text-muted-foreground">
					A small link under the footer of your emails and on your website. Your plan doesn&apos;t need it, so it&apos;s off. Turn it on if you&apos;d like to
					help other writers find FlockStack.
				</p>
			</div>
			<Switch id="sent-with-link" checked={isOn} disabled={isPending} onCheckedChange={change} aria-label="Show Sent with FlockStack" />
		</div>
	);
}
