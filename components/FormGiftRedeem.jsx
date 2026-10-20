"use client";

import { useActionState } from "react";
import { Gift, Link2Off, Loader2, MailCheck } from "lucide-react";
import { redeem } from "@/app/gift/actions";
import CardNotice from "@/components/CardNotice";
import { Button } from "@/components/ui/button";

function formatDay(value) {
	return new Date(value).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

// The recipient's page: the gift in words and one button. gift: lib/gifts.js readGiftForPage.
export default function FormGiftRedeem({ token, gift }) {
	const [state, action, isPending] = useActionState(redeem.bind(null, token), null);
	const length = `${gift.months} ${gift.months === 1 ? "month" : "months"}`;

	if (state?.ok) {
		return (
			<CardNotice icon={MailCheck} tone="success" title="Your gift is yours">
				You have every issue of {gift.newsletterName}, the paid ones included, until {state.until ? formatDay(state.until) : "the end of your gift"}. The next paid issue lands in your inbox.
				{gift.archiveUrl && (
					<Button asChild size="lg" variant="outline" className="mt-6 w-full">
						<a href={gift.archiveUrl}>Read past issues</a>
					</Button>
				)}
			</CardNotice>
		);
	}

	const stopped = {
		expired: ["This gift has expired", `It could be redeemed until ${gift.expiresAt ? formatDay(gift.expiresAt) : "a year after it was bought"}.`],
		redeemed: ["This gift was redeemed", "It can only be redeemed once."],
		refunded: ["This gift was refunded", "It can't be redeemed any more."],
	}[state?.error ?? (gift.state === "expired" || gift.state === "redeemed" || gift.state === "refunded" ? gift.state : "")];
	if (stopped) {
		return (
			<CardNotice icon={Link2Off} title={stopped[0]}>
				{stopped[1]}
				{gift.archiveUrl && (
					<Button asChild size="lg" variant="outline" className="mt-6 w-full">
						<a href={gift.archiveUrl}>Visit {gift.newsletterName}</a>
					</Button>
				)}
			</CardNotice>
		);
	}

	return (
		<CardNotice icon={isPending ? Loader2 : Gift} spin={isPending} title={`${gift.from ?? "Someone"} gave you ${length} of ${gift.newsletterName}`}>
			{gift.message && <blockquote className="mt-3 border-l-2 border-border pl-3 text-left whitespace-pre-line">{gift.message}</blockquote>}
			<p className="mt-3">
				Every issue of the {gift.tierName} tier, the paid ones included. Your {length} start when you redeem it
				{gift.expiresAt ? `, and the gift can be redeemed until ${formatDay(gift.expiresAt)}` : ""}.
			</p>
			{state?.error === "busy" && <p className="mt-2">Too many clicks from your network. Try again in a few minutes.</p>}
			<form action={action} className="mt-6">
				<Button type="submit" size="lg" disabled={isPending} className="w-full">
					{isPending ? "Redeeming…" : "Redeem my gift"}
				</Button>
			</form>
		</CardNotice>
	);
}
