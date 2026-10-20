"use client";

import { useActionState, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { buyGift } from "@/app/archive/shop-actions";
import { Button } from "@/components/ui/button";
import { formatPrice } from "@/lib/payments/config";
import { cn } from "@/lib/utils";

const FIELD =
	"h-11 w-full rounded-xl bg-background px-3 text-base shadow-border outline-none transition-shadow duration-150 placeholder:text-muted-foreground focus-visible:shadow-border-hover focus-visible:ring-3 focus-visible:ring-ring/25";

// The gift page's form: a tier and a length, who it is for, a message and the day it is sent, then Stripe's page. tiers: each
// with its id, name and options ({ months, cents }). today: the first day it can be sent, YYYY-MM-DD.
export default function FormGift({ newsletterSlug, tiers, currency, today, expiryMonths, className }) {
	const [tierId, setTierId] = useState(tiers[0]?.id);
	const tier = tiers.find((candidate) => candidate.id === tierId) ?? tiers[0];
	const [months, setMonths] = useState(tier.options.at(-1)?.months);
	const [state, action, isPending] = useActionState(buyGift, null);
	const chosen = tier.options.find((option) => option.months === months) ?? tier.options.at(-1);

	useEffect(() => {
		if (state?.url) window.location.assign(state.url);
	}, [state]);

	function pickTier(next) {
		setTierId(next.id);
		setMonths(next.options.find((option) => option.months === months)?.months ?? next.options.at(-1)?.months);
	}

	return (
		<form action={action} className={cn("flex flex-col gap-4", className)}>
			<input type="hidden" name="newsletter" value={newsletterSlug} />
			<input type="hidden" name="tier" value={tier.id} />
			<input type="hidden" name="months" value={chosen.months} />
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
								"rounded-xl p-4 text-left text-sm font-medium outline-none transition-[background-color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-ring",
								tier.id === candidate.id ? "bg-muted/60 shadow-[inset_0_0_0_1.5px_var(--foreground)]" : "shadow-border hover:bg-muted/60"
							)}
						>
							{candidate.name}
						</button>
					))}
				</div>
			)}
			<div role="radiogroup" aria-label="Length" className="grid gap-2 sm:grid-cols-2">
				{tier.options.map((option) => (
					<button
						key={option.months}
						type="button"
						role="radio"
						aria-checked={chosen.months === option.months}
						onClick={() => setMonths(option.months)}
						className={cn(
							"flex flex-col items-start gap-0.5 rounded-xl p-4 text-left outline-none transition-[background-color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-ring",
							chosen.months === option.months ? "bg-muted/60 shadow-[inset_0_0_0_1.5px_var(--foreground)]" : "shadow-border hover:bg-muted/60"
						)}
					>
						<span className="text-sm font-medium">{option.months} {option.months === 1 ? "month" : "months"}</span>
						<span className="text-lg font-semibold tracking-tight tabular-nums">{formatPrice(option.cents, currency)}</span>
					</button>
				))}
			</div>
			<input type="email" name="recipientEmail" required placeholder="Their email" aria-label="The email of the person getting the gift" autoComplete="off" className={FIELD} />
			<textarea name="message" rows={3} maxLength={500} placeholder="A message for them (optional, plain text, no links)" aria-label="Your message" className={cn(FIELD, "h-auto py-2.5")} />
			<label className="flex flex-col gap-1.5 text-sm text-muted-foreground">
				Send it on
				<input type="date" name="deliverOn" defaultValue={today} min={today} className={cn(FIELD, "text-foreground")} />
			</label>
			<input type="text" name="buyerName" maxLength={60} placeholder="Your name, shown to them (optional)" aria-label="Your name" autoComplete="name" className={FIELD} />
			<input type="email" name="buyerEmail" required placeholder="Your email, for the receipt" aria-label="Your email" autoComplete="email" className={FIELD} />
			<Button type="submit" size="lg" disabled={isPending || Boolean(state?.url)} className="h-11 rounded-xl">
				{isPending || state?.url ? <Loader2 className="animate-spin" /> : `Continue to payment, ${formatPrice(chosen.cents, currency)}`}
			</Button>
			{state?.error && (
				<p role="alert" className="text-sm text-destructive">
					{state.error}
				</p>
			)}
			<p className="text-xs text-muted-foreground text-pretty">
				You pay once through Stripe. They get an email on the day you pick, with your message and a link to redeem the gift, and their {chosen.months} {chosen.months === 1 ? "month starts" : "months start"} when they do. A gift can be redeemed for {expiryMonths} months after you buy it, then it expires. You get a link to see whether it was redeemed.
			</p>
		</form>
	);
}
