import { buttonVariants } from "@/components/ui/button";
import { formatPrice } from "@/lib/payments/config";
import { cn } from "@/lib/utils";

// The newsletter's paid tier, as a pitch with its prices and a link to the page where readers subscribe.
export default function CardPaidTier({ newsletter, href, className }) {
	const { monthlyCents, yearlyCents, currency, trialDays, pitch } = newsletter.paidTier ?? {};
	const prices = [monthlyCents > 0 && `${formatPrice(monthlyCents, currency)} a month`, yearlyCents > 0 && `${formatPrice(yearlyCents, currency)} a year`].filter(Boolean);

	return (
		<section id="paid" className={cn("flex flex-col gap-4 rounded-2xl bg-card p-6 shadow-border sm:flex-row sm:items-center sm:justify-between sm:p-8", className)}>
			<div className="min-w-0">
				<h2 className="text-xl font-semibold tracking-tight">Become a paid subscriber</h2>
				<p className="mt-2 max-w-lg text-muted-foreground text-pretty">{pitch || `Get every issue of ${newsletter.name}, including the ones for paid subscribers only.`}</p>
				<p className="mt-3 text-sm font-medium tabular-nums">
					{prices.join(" or ")}
					{trialDays > 0 && <span className="font-normal text-muted-foreground"> · {trialDays}-day free trial</span>}
				</p>
			</div>
			<a href={href} className={cn(buttonVariants({ size: "lg" }), "h-11 shrink-0 rounded-xl px-6")}>
				Subscribe
			</a>
		</section>
	);
}
