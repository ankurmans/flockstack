"use client";

import { useActionState, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { subscribePaid } from "@/app/archive/shop-actions";
import { Button } from "@/components/ui/button";
import { formatPrice } from "@/lib/payments/config";
import { cn } from "@/lib/utils";

// The paid tier's signup: a plan and an email, then Stripe's page for the card. prices: { month, year } in cents, 0 when
// the newsletter doesn't offer that plan.
export default function FormSubscribePaid({ newsletterSlug, prices, currency, trialDays = 0, className }) {
	const plans = [
		{ interval: "month", label: "Monthly", cents: prices.month, note: "a month" },
		{ interval: "year", label: "Yearly", cents: prices.year, note: "a year" },
	].filter(({ cents }) => cents > 0);
	const [interval, setInterval] = useState(plans.at(-1)?.interval);
	const [state, action, isPending] = useActionState(subscribePaid, null);

	useEffect(() => {
		if (state?.url) window.location.assign(state.url);
	}, [state]);

	return (
		<form action={action} className={cn("flex flex-col gap-4", className)}>
			<input type="hidden" name="newsletter" value={newsletterSlug} />
			<input type="hidden" name="interval" value={interval} />
			<div aria-hidden="true" className="absolute -left-[10000px] size-px overflow-hidden">
				<input type="text" name="website" tabIndex={-1} autoComplete="off" />
			</div>
			{plans.length > 1 && (
				<div role="radiogroup" aria-label="Plan" className="grid gap-2 sm:grid-cols-2">
					{plans.map((plan) => (
						<button
							key={plan.interval}
							type="button"
							role="radio"
							aria-checked={interval === plan.interval}
							onClick={() => setInterval(plan.interval)}
							className={cn(
								"flex flex-col items-start gap-0.5 rounded-xl p-4 text-left outline-none transition-[background-color,box-shadow] duration-150 focus-visible:ring-3 focus-visible:ring-ring/50",
								interval === plan.interval ? "bg-muted/60 shadow-[inset_0_0_0_1.5px_var(--foreground)]" : "shadow-border hover:bg-muted/60"
							)}
						>
							<span className="text-sm font-medium">{plan.label}</span>
							<span className="text-lg font-semibold tracking-tight tabular-nums">
								{formatPrice(plan.cents, currency)} <span className="text-sm font-normal text-muted-foreground">{plan.note}</span>
							</span>
						</button>
					))}
				</div>
			)}
			<input
				type="email"
				name="email"
				required
				autoComplete="email"
				placeholder="you@example.com"
				aria-label="Email"
				className="h-11 w-full rounded-xl bg-background px-3 text-base shadow-border outline-none transition-shadow duration-150 placeholder:text-muted-foreground focus-visible:shadow-border-hover focus-visible:ring-3 focus-visible:ring-ring/25"
			/>
			<Button type="submit" size="lg" disabled={isPending || Boolean(state?.url)} className="h-11 rounded-xl">
				{isPending || state?.url ? <Loader2 className="animate-spin" /> : trialDays > 0 ? `Start your ${trialDays}-day free trial` : "Continue to payment"}
			</Button>
			{state?.error && (
				<p role="alert" className="text-sm text-destructive">
					{state.error}
				</p>
			)}
			<p className="text-xs text-muted-foreground">You pay through Stripe. Cancel anytime from the link at the bottom of each email.</p>
		</form>
	);
}
