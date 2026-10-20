"use client";

import { useActionState, useEffect, useRef } from "react";
import { HandHeart, Link2Off, Loader2, MailCheck } from "lucide-react";
import { cancelPledge } from "@/app/pledge/actions";
import CardNotice from "@/components/CardNotice";
import { Button } from "@/components/ui/button";

// One click, and the page makes it when it opens: link scanners open the page without submitting forms, so only a person's
// browser cancels the pledge.
export default function FormPledgeCancel({ token, newsletterName }) {
	const [state, action, isPending] = useActionState(cancelPledge.bind(null, token), null);
	const formRef = useRef(null);

	useEffect(() => {
		formRef.current?.requestSubmit();
	}, []);

	if (state?.ok) {
		return (
			<CardNotice icon={MailCheck} tone="success" title="Your pledge is canceled">
				You won&apos;t be charged for {state.newsletterName ?? newsletterName}, and your saved card is removed. You still get the free issues.
			</CardNotice>
		);
	}
	if (state?.error === "converted") {
		return (
			<CardNotice icon={Link2Off} title="You are a paid subscriber now">
				Your pledge to {state.newsletterName} became a subscription. To cancel it, use the manage subscription link at the bottom of any issue.
			</CardNotice>
		);
	}
	if (state?.error === "too-late") {
		return (
			<CardNotice icon={Link2Off} title="It's being charged">
				The charge for your pledge to {state.newsletterName} has started, so it can&apos;t be canceled here. Cancel the subscription from the link at the bottom of any issue.
			</CardNotice>
		);
	}
	if (state?.error === "invalid") {
		return (
			<CardNotice icon={Link2Off} title="This link doesn't work">
				It may be too old. Reply to the email it came in if you want your pledge canceled.
			</CardNotice>
		);
	}

	return (
		<CardNotice icon={isPending ? Loader2 : HandHeart} spin={isPending} title={`Cancel your pledge to ${newsletterName}?`}>
			{state?.error === "busy" ? "Too many clicks from your network. Try again in a few minutes." : "One click, and you won't be charged."}
			<form ref={formRef} action={action} className="mt-6">
				<Button type="submit" size="lg" disabled={isPending} className="w-full">
					{isPending ? "Canceling…" : "Cancel my pledge"}
				</Button>
			</form>
		</CardNotice>
	);
}
