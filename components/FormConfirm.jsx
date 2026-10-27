"use client";
import { getReaderText } from "@/lib/reader-languages";

import { useActionState, useEffect, useRef } from "react";
import { Link2Off, Loader2, MailCheck } from "lucide-react";
import { confirmSubscription } from "@/app/confirm/actions";
import CardNotice from "@/components/CardNotice";
import FormRecommendedSubscribe from "@/components/FormRecommendedSubscribe";
import { Button } from "@/components/ui/button";
import { readGateReturn } from "@/lib/storage";

// Link scanners open the page without submitting forms, so only a person's browser confirms.
export default function FormConfirm({ token, newsletterName, slug, fromName, fromEmail, archiveUrl, language = "en" }) {
	const t = getReaderText(language);
	const [state, action, isPending] = useActionState(confirmSubscription.bind(null, token), null);
	const formRef = useRef(null);

	useEffect(() => {
		formRef.current?.requestSubmit();
	}, []);

	// The newsletter's own page after confirming, unless there are newsletters to offer first.
	const redirectUrl = state?.ok && !state.step ? state.redirectUrl : null;
	useEffect(() => {
		if (redirectUrl) window.location.replace(redirectUrl);
	}, [redirectUrl]);

	if (state?.ok && state.held) {
		return (
			<CardNotice icon={MailCheck} tone="success" title={t("You're confirmed")}>
				{t("{name} approves new subscribers. You'll get the next issue once the owner says yes.", { name: newsletterName })}
			</CardNotice>
		);
	}

	if (state?.ok) {
		// A gated issue the reader signed up on, in this browser: the full issue opens there now.
		const gateReturn = readGateReturn(slug);
		return (
			<CardNotice icon={MailCheck} tone="success" title={t("You're in")}>
				{language === "en" ? <>The next issue of {newsletterName} comes from{" "}
				<span className="font-medium text-foreground">{fromName || fromEmail}</span>
				{fromName && ` (${fromEmail})`}. If it lands in Promotions, drag it to Primary.</> : t("Confirmed. Future issues come from {sender}.", { sender: fromName || fromEmail })}
				{gateReturn && (
					<Button asChild size="lg" className="mt-6 w-full">
						<a href={gateReturn}>{t("Keep reading")}</a>
					</Button>
				)}
				{state.redirectUrl ? (
					<Button asChild size="lg" variant="outline" className="mt-6 w-full">
						<a href={state.redirectUrl}>{t("Continue")}</a>
					</Button>
				) : (
					archiveUrl && (
						<Button asChild size="lg" variant="outline" className="mt-6 w-full">
							<a href={archiveUrl}>{t("Read past issues")}</a>
						</Button>
					)
				)}
				{state.step && <FormRecommendedSubscribe language={language} step={state.step} className="mt-6 border-t border-border/60 pt-5" />}
			</CardNotice>
		);
	}

	if (state?.error) {
		return (
			<CardNotice icon={Link2Off} title={t("This link doesn't work")}>
				{t("It may be older than 30 days. Sign up again and use the newest confirmation email.")}
			</CardNotice>
		);
	}

	return (
		<CardNotice
			icon={isPending ? Loader2 : MailCheck}
			spin={isPending}
			title={t("Confirm your subscription to {name}", { name: newsletterName })}
		>
			{t("One click and the next issue lands in your inbox.")}
			<form ref={formRef} action={action} className="mt-6">
				<Button type="submit" size="lg" disabled={isPending} className="w-full">
					{isPending ? t("Confirming…") : t("Confirm my subscription")}
				</Button>
			</form>
		</CardNotice>
	);
}
