"use client";
import { getReaderText } from "@/lib/reader-languages";

import { useActionState, useEffect, useRef } from "react";
import { HeartHandshake, Link2Off, Loader2, MailCheck } from "lucide-react";
import { keepSending } from "@/app/keep/actions";
import CardNotice from "@/components/CardNotice";
import { Button } from "@/components/ui/button";

// Link scanners open the page without submitting forms, so only a person's browser says yes.
export default function FormKeep({ token, newsletterName, archiveUrl, language = "en" }) {
	const t = getReaderText(language);
	const [state, action, isPending] = useActionState(keepSending.bind(null, token), null);
	const formRef = useRef(null);

	useEffect(() => {
		formRef.current?.requestSubmit();
	}, []);

	if (state?.ok) {
		return (
			<CardNotice icon={MailCheck} tone="success" title={t("You'll keep getting {name}", { name: newsletterName })}>
				{t("Thanks for letting me know. The next issue lands in your inbox.")}
				{archiveUrl && (
					<Button asChild size="lg" variant="outline" className="mt-6 w-full">
						<a href={archiveUrl}>{t("Read past issues")}</a>
					</Button>
				)}
			</CardNotice>
		);
	}

	if (state?.error === "invalid") {
		return (
			<CardNotice icon={Link2Off} title={t("This link doesn't work")}>
				{t("Sign up again to keep receiving issues.")}
				{archiveUrl && (
					<Button asChild size="lg" variant="outline" className="mt-6 w-full">
						<a href={archiveUrl}>{t("Sign up again")}</a>
					</Button>
				)}
			</CardNotice>
		);
	}

	return (
		<CardNotice
			icon={isPending ? Loader2 : HeartHandshake}
			spin={isPending}
			title={t("Keep getting {name}?", { name: newsletterName })}
		>
			{state?.error === "busy"
				? t("Too many clicks from your network. Try again in a few minutes.")
				: t("One click and it keeps coming.")}
			<form ref={formRef} action={action} className="mt-6">
				<Button type="submit" size="lg" disabled={isPending} className="w-full">
					{isPending ? t("Saving…") : t("Yes, keep sending it")}
				</Button>
			</form>
		</CardNotice>
	);
}
