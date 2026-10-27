import { getReaderText } from "@/lib/reader-languages";
import { Link2Off } from "lucide-react";
import CardNotice from "@/components/CardNotice";
import { readBuyerGifts } from "@/lib/gifts";

// The URL carries the buyer's token: keep it out of search results and referrer headers.
export const metadata = {
	title: "Your gifts",
	robots: { index: false, follow: false },
	referrer: "no-referrer",
};

const STATE_WORDS = { paid: "Waiting for its delivery day", sent: "Sent, not redeemed yet", redeemed: "Redeemed", expired: "Expired, never redeemed", refunded: "Refunded" };

function formatDay(value, language) {
	return new Date(value).toLocaleDateString(language, { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export default async function GiftsPage({ searchParams }) {
	const { token } = await searchParams;
	const data = typeof token === "string" ? await readBuyerGifts(token).catch(() => null) : null;

	const t = getReaderText(data?.language);
	if (!data) {
		return (
			<main className="theme-neutral flex min-h-dvh items-center justify-center bg-background px-4 py-16">
				<CardNotice icon={Link2Off} title="This link doesn't work">
					{t("Check that you opened the whole link from your receipt.")}
				</CardNotice>
			</main>
		);
	}


	return (
		<main lang={t.language} className="theme-neutral min-h-dvh bg-background px-4 py-16">
			<div className="mx-auto max-w-xl">
				<h1 className="text-3xl font-semibold tracking-tight text-balance">{t("Your gifts to {name}", { name: data.newsletterName })}</h1>
				<p className="mt-3 text-muted-foreground text-pretty">{t("A gift that nobody redeems expires a year after you bought it.")}</p>
				<ul className="mt-8 flex flex-col gap-3">
					{data.gifts.map((gift) => (
						<li key={gift.id} className="rounded-xl bg-card p-4 text-sm shadow-border">
							<p className="font-medium">
								{t("{duration} of {tier} for {email}", { duration: `${gift.months} ${t(gift.months === 1 ? "month" : "months")}`, tier: gift.tierName, email: gift.recipientEmail })}
							</p>
							<p className="mt-1 text-muted-foreground tabular-nums">
								{t(STATE_WORDS[gift.state])}
								{gift.state === "redeemed" && gift.redeemedAt ? ` ${t("on {date}", { date: formatDay(gift.redeemedAt, t.language) })}` : ""}
								{gift.state === "paid" ? `: ${formatDay(gift.deliverOn, t.language)}` : ""}
								{(gift.state === "paid" || gift.state === "sent") && gift.expiresAt ? `. ${t("Expires {date}", { date: formatDay(gift.expiresAt, t.language) })}` : ""}. {gift.amount}.
							</p>
							{gift.deliveryError && <p className="mt-1 text-destructive">{t("The email didn't reach them. Reply to your receipt and we'll sort it out.")}</p>}
							{gift.redeemUrl && (
								<p className="mt-2 text-xs text-muted-foreground">
									{t("The gift's link, to give them yourself:")}{" "}
									<a href={gift.redeemUrl} className="break-all font-mono underline underline-offset-4 hover:text-foreground">
										{gift.redeemUrl}
									</a>
								</p>
							)}
						</li>
					))}
				</ul>
				{data.giveUrl && (
					<p className="mt-8 text-sm text-muted-foreground">
						<a href={data.giveUrl} className="underline underline-offset-4 hover:text-foreground">
							{t("Give another gift")}
						</a>
					</p>
				)}
			</div>
		</main>
	);
}
