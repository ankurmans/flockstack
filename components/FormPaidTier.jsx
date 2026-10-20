"use client";

import { useActionState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { savePaidTier } from "@/app/(app)/payments/actions";
import ButtonCopy from "@/components/ButtonCopy";
import CardSettings, { RowSettings } from "@/components/CardSettings";
import GatePlan from "@/components/GatePlan";
import SelectCurrency from "@/components/SelectCurrency";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatCount } from "@/lib/format";
import { submitKeepingFields } from "@/lib/submit-keeping-fields";
import { toast } from "@/lib/toast";
import { useToastError } from "@/lib/use-toast-error";

const toInput = (cents) => (cents > 0 ? (cents / 100).toFixed(2).replace(/\.00$/, "") : "");

// The open newsletter's paid settings: readers subscribe through Stripe on your account, and paid issues go to them alone.
// The tiers themselves are in CardPaidTiers. tier: get_paid_tier's answer. isReady: payments can take a charge.
export default function FormPaidTier({ newsletter, tier, isReady }) {
	const toastError = useToastError();
	const [state, action, isPending] = useActionState(async (previous, formData) => {
		const result = await savePaidTier(previous, formData);
		if (result?.error) {
			toastError(result);
			return result;
		}
		toast.success("Saved");
		return { ...result, savedAt: Date.now() };
	}, null);

	return (
		// A new key after each save: the fields start again from what was saved.
		<form key={state?.savedAt ?? 0} action={action} onSubmit={submitKeepingFields(action)}>
			<input type="hidden" name="newsletterId" value={newsletter.id} />
			<CardSettings
				title={`Paid tier of ${newsletter.name}`}
				stagger={1}
				action={
					<GatePlan reason="sell">
						<Button type="submit" size="sm" disabled={isPending} className="min-w-16">
							{isPending ? <Loader2 className="animate-spin" /> : "Save"}
						</Button>
					</GatePlan>
				}
			>
				<RowSettings label="Paid tier" isLabel hint={isReady ? "Turning it off closes the page to new subscribers. People already subscribed keep paying until they cancel in Stripe." : "Needs a Stripe account that can take payments."}>
					<span className="flex items-center gap-2.5 py-2 text-sm">
						<input type="checkbox" name="enabled" defaultChecked={tier.enabled} disabled={!isReady && !tier.enabled} className="size-4 accent-foreground" />
						Readers can subscribe
					</span>
				</RowSettings>
				<RowSettings label="Monthly price" isLabel hint={tier.tierCount > 1 ? "The lowest tier's price. The tiers below have their own." : "Leave empty to not offer a monthly plan."}>
					<Input name="monthly" inputMode="decimal" defaultValue={toInput(tier.monthlyCents)} placeholder="e.g. 8" />
				</RowSettings>
				<RowSettings label="Yearly price" isLabel hint={tier.tierCount > 1 ? "The lowest tier's price." : "Leave empty to not offer a yearly plan."}>
					<Input name="yearly" inputMode="decimal" defaultValue={toInput(tier.yearlyCents)} placeholder="e.g. 80" />
				</RowSettings>
				<RowSettings label="Currency" isLabel hint="Prices apply to new subscribers. Earlier ones keep what they pay.">
					<SelectCurrency name="currency" defaultValue={tier.currency} />
				</RowSettings>
				<RowSettings label="Free trial" isLabel hint="Days before the first charge. 0 for none. Lifetime has no trial.">
					<Input name="trialDays" inputMode="numeric" defaultValue={tier.trialDays} className="w-28" />
					<span className="flex items-center gap-2.5 py-1 text-sm">
						<input type="checkbox" name="trialNoCard" defaultChecked={tier.trialNoCard} className="size-4 accent-foreground" />
						Ask for no card until the trial ends
					</span>
				</RowSettings>
				<RowSettings label="Supporters list" isLabel hint="Shows the names founding members gave on the subscribe page, never their emails. Off unless you turn it on.">
					<span className="flex items-center gap-2.5 py-2 text-sm">
						<input type="checkbox" name="supportersPublic" defaultChecked={tier.supportersPublic} className="size-4 accent-foreground" />
						Show a supporters list
					</span>
				</RowSettings>
				<RowSettings label="Pitch" isLabel hint="A line or two on why to subscribe, shown on the subscribe page.">
					<Textarea name="pitch" defaultValue={tier.pitch} maxLength={300} rows={3} />
				</RowSettings>
				{tier.subscribeUrl && (
					<div className="flex items-center gap-2 px-4 py-3">
						<a
							href={tier.subscribeUrl}
							target="_blank"
							rel="noreferrer"
							className="flex min-w-0 items-center gap-1.5 truncate font-mono text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground"
						>
							<ExternalLink className="size-3.5 shrink-0" />
							<span className="truncate">{tier.subscribeUrl}</span>
						</a>
						<ButtonCopy value={tier.subscribeUrl} label="Copy link" />
					</div>
				)}
				<p className="px-4 py-3 text-sm text-muted-foreground tabular-nums">
					{formatCount(tier.paidSubscribers, "paid subscriber")}
					{tier.compSubscribers + tier.giftSubscribers > 0 && `: ${tier.payingSubscribers} paying, ${tier.compSubscribers} on a comp, ${tier.giftSubscribers} on a gift`}. Send an issue to paid readers only from the campaign&apos;s send step.
				</p>
			</CardSettings>
			{state?.error && <p className="mt-2 text-sm text-destructive">{state.error}</p>}
		</form>
	);
}
