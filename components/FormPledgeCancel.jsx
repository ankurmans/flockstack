"use client";
import useReaderText from "@/components/useReaderText";

import { useActionState, useEffect, useRef } from "react";
import { HandHeart, Link2Off, Loader2, MailCheck } from "lucide-react";
import { cancelPledge } from "@/app/pledge/actions";
import CardNotice from "@/components/CardNotice";
import { Button } from "@/components/ui/button";

// One click, and the page makes it when it opens: link scanners open the page without submitting forms, so only a person's
// browser cancels the pledge.
export default function FormPledgeCancel({ token, newsletterName }) {
	const t = useReaderText();
	const [state, action, isPending] = useActionState(cancelPledge.bind(null, token), null);
	const formRef = useRef(null);

	useEffect(() => {
		formRef.current?.requestSubmit();
	}, []);

	if (state?.ok) {
		return (
			<CardNotice icon={MailCheck} tone="success" title={t("Your pledge is canceled")}>
				{t("You won't be charged for {name}, and your saved card is removed. You still get the free issues.", { name: state.newsletterName ?? newsletterName })}
			</CardNotice>
		);
	}
	if (state?.error === "converted") {
		return (
			<CardNotice icon={Link2Off} title={t("You are a paid subscriber now")}>
				{t("Your pledge to {name} became a subscription. To cancel it, use the manage subscription link at the bottom of any issue.", { name: state.newsletterName })}
			</CardNotice>
		);
	}
	if (state?.error === "too-late") {
		return (
			<CardNotice icon={Link2Off} title={t("It's being charged")}>
				{t("The charge for your pledge to {name} has started, so it can't be canceled here. Cancel the subscription from the link at the bottom of any issue.", { name: state.newsletterName })}
			</CardNotice>
		);
	}
	if (state?.error === "invalid") {
		return (
			<CardNotice icon={Link2Off} title={t("This link doesn't work")}>
				{t("It may be too old. Reply to the email it came in if you want your pledge canceled.")}
			</CardNotice>
		);
	}

	return (
		<CardNotice icon={isPending ? Loader2 : HandHeart} spin={isPending} title={t("Cancel your pledge to {name}?", { name: newsletterName })}>
			{state?.error === "busy" ? t("Too many clicks from your network. Try again in a few minutes.") : t("One click, and you won't be charged.")}
			<form ref={formRef} action={action} className="mt-6">
				<Button type="submit" size="lg" disabled={isPending} className="w-full">
					{isPending ? t("Canceling…") : t("Cancel my pledge")}
				</Button>
			</form>
		</CardNotice>
	);
}
