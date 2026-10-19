"use client";

import { useActionState, useId } from "react";
import { Loader2 } from "lucide-react";
import { saveExtraEmailsLimit } from "@/app/(account)/billing/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatNumber, formatUsdCents } from "@/lib/format";
import { toast } from "@/lib/toast";

// Extra emails on the billing page (get_billing's extraEmails): this month's count and cost, and the owner's limit.
// planEmails: the plan's own emails a month.
export default function CardExtraEmails({ extraEmails, planEmails }) {
	const id = useId();
	const { sent, limit, maxLimit, estimatedCost, pricePerThousand } = extraEmails;
	const [, action, isPending] = useActionState(async (previous, formData) => {
		const result = await saveExtraEmailsLimit(previous, formData);
		if (result?.error) toast.error(result.error);
		else toast.success(result.limit ? `Up to ${formatNumber(result.limit)} extra emails a month` : "No extra emails: sending stops at your plan's emails");
		return result;
	}, null);
	const ratio = limit > 0 ? Math.min(sent / limit, 1) : 0;

	return (
		<div className="flex flex-col gap-5 rounded-xl bg-card p-4 shadow-border sm:p-5">
			<div className="grid gap-4 sm:grid-cols-2">
				<div className="flex flex-col gap-1">
					<span className="text-sm text-muted-foreground">Extra emails this month</span>
					<p className="flex items-baseline gap-1.5 tabular-nums">
						<span className="text-2xl font-semibold tracking-tight">{formatNumber(sent)}</span>
						<span className="text-sm text-muted-foreground">of {formatNumber(limit)}</span>
					</p>
				</div>
				<div className="flex flex-col gap-1">
					<span className="text-sm text-muted-foreground">Estimated cost</span>
					<p className="text-2xl font-semibold tracking-tight tabular-nums">{formatUsdCents(estimatedCost)}</p>
				</div>
			</div>
			<div
				role="meter"
				aria-label="Extra emails this month"
				aria-valuemin={0}
				aria-valuemax={limit}
				aria-valuenow={Math.min(sent, limit)}
				className="h-1.5 overflow-hidden rounded-full bg-muted"
			>
				<div
					className={ratio >= 1 ? "h-full rounded-full bg-red-500" : ratio >= 0.8 ? "h-full rounded-full bg-amber-500" : "h-full rounded-full bg-foreground/70"}
					style={{ width: `${Math.max(ratio * 100, ratio > 0 ? 2 : 0)}%` }}
				/>
			</div>
			<p className="text-sm text-pretty text-muted-foreground">
				Past your plan&apos;s {formatNumber(planEmails)} emails, sending goes on at {formatUsdCents(pricePerThousand)} per 1,000 extra emails, billed
				with your plan at the end of the period. Sending stops at your limit, and we email you at 80% and 100% of it.
			</p>
			<form action={action} className="flex flex-col gap-2 border-t border-border/70 pt-4 sm:flex-row sm:items-end sm:gap-3">
				<div className="flex flex-1 flex-col gap-1.5">
					<label htmlFor={`${id}-limit`} className="text-sm font-medium">
						Monthly limit on extra emails
					</label>
					<Input
						id={`${id}-limit`}
						name="limit"
						inputMode="numeric"
						defaultValue={formatNumber(limit)}
						aria-describedby={`${id}-hint`}
						className="tabular-nums sm:max-w-56"
						autoComplete="off"
					/>
					<p id={`${id}-hint`} className="text-xs text-muted-foreground tabular-nums">
						0 stops at your plan&apos;s emails. Up to {formatNumber(maxLimit)}, about {formatUsdCents((maxLimit * pricePerThousand) / 1000)} at most.
					</p>
				</div>
				<Button type="submit" variant="outline" disabled={isPending} className="sm:mb-6 sm:min-w-24">
					{isPending ? <Loader2 className="animate-spin" /> : "Save"}
				</Button>
			</form>
		</div>
	);
}
