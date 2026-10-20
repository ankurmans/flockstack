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

function formatDay(value) {
	return new Date(value).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export default async function GiftsPage({ searchParams }) {
	const { token } = await searchParams;
	const data = typeof token === "string" ? await readBuyerGifts(token).catch(() => null) : null;

	if (!data) {
		return (
			<main className="theme-neutral flex min-h-dvh items-center justify-center bg-background px-4 py-16">
				<CardNotice icon={Link2Off} title="This link doesn't work">
					Check that you opened the whole link from your receipt.
				</CardNotice>
			</main>
		);
	}

	return (
		<main className="theme-neutral min-h-dvh bg-background px-4 py-16">
			<div className="mx-auto max-w-xl">
				<h1 className="text-3xl font-semibold tracking-tight text-balance">Your gifts to {data.newsletterName}</h1>
				<p className="mt-3 text-muted-foreground text-pretty">A gift that nobody redeems expires a year after you bought it.</p>
				<ul className="mt-8 flex flex-col gap-3">
					{data.gifts.map((gift) => (
						<li key={gift.id} className="rounded-xl bg-card p-4 text-sm shadow-border">
							<p className="font-medium">
								{gift.months} {gift.months === 1 ? "month" : "months"} of {gift.tierName} for {gift.recipientEmail}
							</p>
							<p className="mt-1 text-muted-foreground tabular-nums">
								{STATE_WORDS[gift.state]}
								{gift.state === "redeemed" && gift.redeemedAt ? ` on ${formatDay(gift.redeemedAt)}` : ""}
								{gift.state === "paid" ? `: ${formatDay(gift.deliverOn)}` : ""}
								{(gift.state === "paid" || gift.state === "sent") && gift.expiresAt ? `. Expires ${formatDay(gift.expiresAt)}` : ""}. {gift.amount}.
							</p>
							{gift.deliveryError && <p className="mt-1 text-destructive">The email didn&apos;t reach them. Reply to your receipt and we&apos;ll sort it out.</p>}
							{gift.redeemUrl && (
								<p className="mt-2 text-xs text-muted-foreground">
									The gift&apos;s link, to give them yourself:{" "}
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
							Give another gift
						</a>
					</p>
				)}
			</div>
		</main>
	);
}
