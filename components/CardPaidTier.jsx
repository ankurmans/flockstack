import { getReaderText } from "@/lib/reader-languages";
import { buttonVariants } from "@/components/ui/button";
import { formatPrice as priceInCurrency } from "@/lib/payments/config";
import { describePrices, getNewsletterTiers, getOfferedTiers } from "@/lib/tier-rules";
import { cn } from "@/lib/utils";

// The newsletter's paid tier, as a pitch with its prices and a link to the page where readers subscribe.
export default function CardPaidTier({ language = "en", newsletter, href, className }) {
	const t = getReaderText(language);
	const formatPrice = (cents, currency) => priceInCurrency(cents, currency, t.language);
	const { currency, trialDays, pitch } = newsletter.paidTier ?? {};
	const tiers = getOfferedTiers(getNewsletterTiers(newsletter));
	const lines = tiers.length === 1 ? [describePrices(tiers[0], formatPrice, currency, t)] : tiers.map((tier) => `${tier.name}: ${describePrices(tier, formatPrice, currency, t)}`);

	return (
		<section id="paid" className={cn("flex flex-col gap-4 rounded-2xl bg-card p-6 shadow-border sm:flex-row sm:items-center sm:justify-between sm:p-8", className)}>
			<div className="min-w-0">
				<h2 className="text-xl font-semibold tracking-tight">{t("Become a paid subscriber")}</h2>
				<p className="mt-2 max-w-lg text-muted-foreground text-pretty">{pitch || t("Get every issue of {name}, including the ones for paid subscribers only.", { name: newsletter.name })}</p>
				<div className="mt-3 flex flex-col gap-0.5 text-sm font-medium tabular-nums">
					{lines.map((line) => (
						<p key={line}>{line}</p>
					))}
					{trialDays > 0 && <p className="font-normal text-muted-foreground">{t("{days}-day free trial", { days: trialDays })}</p>}
				</div>
			</div>
			<a href={href} className={cn(buttonVariants({ size: "lg" }), "h-11 shrink-0 rounded-xl px-6")}>
				{t("Subscribe")}
			</a>
		</section>
	);
}
