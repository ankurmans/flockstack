"use client";

import { useActionState, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { subscribePaid } from "@/app/archive/shop-actions";
import { Button } from "@/components/ui/button";
import { formatPrice } from "@/lib/payments/config";
import { cn } from "@/lib/utils";

// The paid tiers' signup: a tier, a plan and an email, then Stripe's page for the card. tiers: each with its id, name,
// description, benefits, founding ({ enabled, spotsLeft }, spotsLeft null without a cap) and options ({ option, label, cents,
// note }), the ways to pay; cents is the least for pay what you want. offer: an offer link's code, which Checkout applies.
export default function FormSubscribePaid({ newsletterSlug, tiers, currency, trialDays = 0, offer = "", className }) {
	const [tierId, setTierId] = useState(tiers[0]?.id);
	const tier = tiers.find((candidate) => candidate.id === tierId) ?? tiers[0];
	const [option, setOption] = useState(tier.options.at(-1)?.option);
	const [state, action, isPending] = useActionState(subscribePaid, null);
	const chosen = tier.options.find((candidate) => candidate.option === option) ?? tier.options.at(-1);
	const isLifetime = chosen?.option === "lifetime";

	useEffect(() => {
		if (state?.url) window.location.assign(state.url);
	}, [state]);

	function pickTier(next) {
		setTierId(next.id);
		setOption(next.options.find((candidate) => candidate.option === option)?.option ?? next.options.at(-1)?.option);
	}

	return (
		<form action={action} className={cn("flex flex-col gap-4", className)}>
			<input type="hidden" name="newsletter" value={newsletterSlug} />
			<input type="hidden" name="tier" value={tier.id} />
			<input type="hidden" name="option" value={chosen?.option} />
			<input type="hidden" name="offer" value={offer} />
			<div aria-hidden="true" className="absolute -left-[10000px] size-px overflow-hidden">
				<input type="text" name="website" tabIndex={-1} autoComplete="off" />
			</div>
			{tiers.length > 1 && (
				<div role="radiogroup" aria-label="Tier" className="grid gap-2">
					{tiers.map((candidate) => (
						<button
							key={candidate.id}
							type="button"
							role="radio"
							aria-checked={tier.id === candidate.id}
							onClick={() => pickTier(candidate)}
							className={cn(
								"flex flex-col items-start gap-1 rounded-xl p-4 text-left outline-none transition-[background-color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-ring",
								tier.id === candidate.id ? "bg-muted/60 shadow-[inset_0_0_0_1.5px_var(--foreground)]" : "shadow-border hover:bg-muted/60"
							)}
						>
							<span className="flex w-full items-baseline justify-between gap-3">
								<span className="flex items-center gap-2 text-sm font-medium">
									{candidate.name}
									{candidate.founding.enabled && <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">Founding member</span>}
								</span>
								<span className="text-sm tabular-nums text-muted-foreground">from {formatPrice(Math.min(...candidate.options.map((entry) => entry.cents)), currency)}</span>
							</span>
							{candidate.description && <span className="text-sm text-muted-foreground text-pretty">{candidate.description}</span>}
							{candidate.founding.spotsLeft !== null && (
								<span className="text-xs text-muted-foreground tabular-nums">
									{candidate.founding.spotsLeft} {candidate.founding.spotsLeft === 1 ? "spot" : "spots"} left
								</span>
							)}
						</button>
					))}
				</div>
			)}
			{tiers.length === 1 && tier.id !== "paid" && (
				<div className="flex flex-col gap-1">
					<p className="text-sm font-medium">{tier.name}</p>
					{tier.description && <p className="text-sm text-muted-foreground text-pretty">{tier.description}</p>}
				</div>
			)}
			{tier.founding.enabled && (
				<p className="rounded-xl bg-muted/60 px-4 py-3 text-sm text-muted-foreground text-pretty">
					You get the same issues as every paid subscriber. A founding membership is a way to back the writing for more.
					{tier.founding.canName && " You can give a name for the supporters list on the next page."}
				</p>
			)}
			{tier.benefits.length > 0 && (
				<ul className="flex flex-col gap-1.5 text-sm text-muted-foreground">
					{tier.benefits.map((benefit) => (
						<li key={benefit} className="flex gap-2">
							<span aria-hidden="true">+</span>
							<span>{benefit}</span>
						</li>
					))}
				</ul>
			)}
			{tier.options.length > 1 && (
				<div role="radiogroup" aria-label="Plan" className={cn("grid gap-2", tier.options.length > 2 ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
					{tier.options.map((plan) => (
						<button
							key={plan.option}
							type="button"
							role="radio"
							aria-checked={chosen.option === plan.option}
							onClick={() => setOption(plan.option)}
							className={cn(
								"flex flex-col items-start gap-0.5 rounded-xl p-4 text-left outline-none transition-[background-color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-ring",
								chosen.option === plan.option ? "bg-muted/60 shadow-[inset_0_0_0_1.5px_var(--foreground)]" : "shadow-border hover:bg-muted/60"
							)}
						>
							<span className="text-sm font-medium">{plan.label}</span>
							<span className="text-lg font-semibold tracking-tight tabular-nums">
								{plan.option === "pwyw" && <span className="text-sm font-normal text-muted-foreground">from </span>}
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
				{isPending || state?.url ? <Loader2 className="animate-spin" /> : trialDays > 0 && !isLifetime ? `Start your ${trialDays}-day free trial` : "Continue to payment"}
			</Button>
			{state?.error && (
				<p role="alert" className="text-sm text-destructive">
					{state.error}
				</p>
			)}
			<p className="text-xs text-muted-foreground">
				{isLifetime ? "You pay once through Stripe, and it never renews." : "You pay through Stripe. Cancel anytime from the link at the bottom of each email."}
			</p>
		</form>
	);
}
