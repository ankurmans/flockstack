"use client";
import useReaderText from "@/components/useReaderText";

import { useActionState } from "react";
import { Gift, Link2Off, Loader2, MailCheck } from "lucide-react";
import { redeem } from "@/app/gift/actions";
import CardNotice from "@/components/CardNotice";
import { Button } from "@/components/ui/button";

function formatDay(value, language = "en") {
	return new Date(value).toLocaleDateString(language, { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

// The recipient's page: the gift in words and one button. gift: lib/gifts.js readGiftForPage.
export default function FormGiftRedeem({ token, gift }) {
	const t = useReaderText();
	const [state, action, isPending] = useActionState(redeem.bind(null, token), null);
	const length = `${gift.months} ${t(gift.months === 1 ? "month" : "months")}`;

	if (state?.ok) {
		return (
			<CardNotice icon={MailCheck} tone="success" title={t("Your gift is yours")}>
				{t("You have every issue of {name}, the paid ones included, until {date}. The next paid issue lands in your inbox.", { name: gift.newsletterName, date: state.until ? formatDay(state.until, t.language) : t("the end of your gift") })}
				{gift.archiveUrl && (
					<Button asChild size="lg" variant="outline" className="mt-6 w-full">
						<a href={gift.archiveUrl}>{t("Read past issues")}</a>
					</Button>
				)}
			</CardNotice>
		);
	}

	const stopped = {
		expired: ["This gift has expired", t("It could be redeemed until {date}.", { date: gift.expiresAt ? formatDay(gift.expiresAt, t.language) : t("a year after it was bought") })],
		redeemed: ["This gift was redeemed", "It can only be redeemed once."],
		refunded: ["This gift was refunded", "It can't be redeemed any more."],
	}[state?.error ?? (gift.state === "expired" || gift.state === "redeemed" || gift.state === "refunded" ? gift.state : "")];
	if (stopped) {
		return (
			<CardNotice icon={Link2Off} title={t(stopped[0])}>
				{t(stopped[1])}
				{gift.archiveUrl && (
					<Button asChild size="lg" variant="outline" className="mt-6 w-full">
						<a href={gift.archiveUrl}>{t("Visit {name}", { name: gift.newsletterName })}</a>
					</Button>
				)}
			</CardNotice>
		);
	}

	return (
		<CardNotice icon={isPending ? Loader2 : Gift} spin={isPending} title={t("{from} gave you {duration} of {name}", { from: gift.from ?? t("Someone"), duration: length, name: gift.newsletterName })}>
			{gift.message && <blockquote className="mt-3 border-l-2 border-border pl-3 text-left whitespace-pre-line">{gift.message}</blockquote>}
			<p className="mt-3">
				{t("Every issue of the {tier} tier, including paid issues. Your {duration} start when you redeem it.", { tier: gift.tierName, duration: length })}
				{gift.expiresAt && ` ${t("Redeem by {date}.", { date: formatDay(gift.expiresAt, t.language) })}`}
			</p>
			{state?.error === "busy" && <p className="mt-2">{t("Too many clicks from your network. Try again in a few minutes.")}</p>}
			<form action={action} className="mt-6">
				<Button type="submit" size="lg" disabled={isPending} className="w-full">
					{isPending ? t("Redeeming…") : t("Redeem my gift")}
				</Button>
			</form>
		</CardNotice>
	);
}
