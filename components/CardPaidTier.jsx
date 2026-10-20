import { buttonVariants } from "@/components/ui/button";
import { formatPrice } from "@/lib/payments/config";
import { describePrices, getNewsletterTiers, getOfferedTiers } from "@/lib/tier-rules";
import { cn } from "@/lib/utils";

// The newsletter's paid tier, as a pitch with its prices and a link to the page where readers subscribe.
export default function CardPaidTier({ newsletter, href, className }) {
	const { currency, trialDays, pitch } = newsletter.paidTier ?? {};
	const tiers = getOfferedTiers(getNewsletterTiers(newsletter));
	const lines = tiers.length === 1 ? [describePrices(tiers[0], formatPrice, currency)] : tiers.map((tier) => `${tier.name}: ${describePrices(tier, formatPrice, currency)}`);

	return (
		<section id="paid" className={cn("flex flex-col gap-4 rounded-2xl bg-card p-6 shadow-border sm:flex-row sm:items-center sm:justify-between sm:p-8", className)}>
			<div className="min-w-0">
				<h2 className="text-xl font-semibold tracking-tight">Become a paid subscriber</h2>
				<p className="mt-2 max-w-lg text-muted-foreground text-pretty">{pitch || `Get every issue of ${newsletter.name}, including the ones for paid subscribers only.`}</p>
				<div className="mt-3 flex flex-col gap-0.5 text-sm font-medium tabular-nums">
					{lines.map((line) => (
						<p key={line}>{line}</p>
					))}
					{trialDays > 0 && <p className="font-normal text-muted-foreground">{trialDays}-day free trial</p>}
				</div>
			</div>
			<a href={href} className={cn(buttonVariants({ size: "lg" }), "h-11 shrink-0 rounded-xl px-6")}>
				Subscribe
			</a>
		</section>
	);
}
