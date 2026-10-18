"use client";

import { useActionState, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { buyProduct } from "@/app/archive/shop-actions";
import { Button } from "@/components/ui/button";
import { formatPrice } from "@/lib/payments/config";
import { cn } from "@/lib/utils";

// The buy form of a product's page. Stripe asks for the email and the card; the email here only fills its field in, and the
// box asks for what the buyer agrees to: joining the newsletter's list, which they don't have to.
export default function FormBuyProduct({ newsletterSlug, productSlug, priceCents, currency, canJoinList, className }) {
	const [state, action, isPending] = useActionState(buyProduct, null);

	useEffect(() => {
		if (state?.url) window.location.assign(state.url);
	}, [state]);

	return (
		<form action={action} className={cn("flex flex-col gap-3", className)}>
			<input type="hidden" name="newsletter" value={newsletterSlug} />
			<input type="hidden" name="product" value={productSlug} />
			<div aria-hidden="true" className="absolute -left-[10000px] size-px overflow-hidden">
				<input type="text" name="website" tabIndex={-1} autoComplete="off" />
			</div>
			<input
				type="email"
				name="email"
				autoComplete="email"
				placeholder="Your email (optional)"
				aria-label="Email"
				className="h-11 w-full rounded-xl bg-background px-3 text-base shadow-border outline-none transition-shadow duration-150 placeholder:text-muted-foreground focus-visible:shadow-border-hover focus-visible:ring-3 focus-visible:ring-ring/25"
			/>
			{canJoinList && (
				<label className="flex items-start gap-2.5 text-sm text-muted-foreground">
					<input type="checkbox" name="addToList" className="mt-0.5 size-4 shrink-0 accent-foreground" />
					<span>Also send me the newsletter, free. Unsubscribe anytime.</span>
				</label>
			)}
			<Button type="submit" size="lg" disabled={isPending || Boolean(state?.url)} className="h-11 rounded-xl">
				{isPending || state?.url ? <Loader2 className="animate-spin" /> : `Buy for ${formatPrice(priceCents, currency)}`}
			</Button>
			{state?.error && (
				<p role="alert" className="text-sm text-destructive">
					{state.error}
				</p>
			)}
			<p className="text-xs text-muted-foreground">You pay through Stripe. The download link comes to your email.</p>
		</form>
	);
}
