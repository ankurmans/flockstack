"use client";

import { useActionState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { saveGifts } from "@/app/(app)/payments/actions";
import ButtonCopy from "@/components/ButtonCopy";
import CardSettings, { RowSettings } from "@/components/CardSettings";
import GatePlan from "@/components/GatePlan";
import { Button } from "@/components/ui/button";
import { formatPrice } from "@/lib/payments/config";
import { submitKeepingFields } from "@/lib/submit-keeping-fields";
import { toast } from "@/lib/toast";
import { useToastError } from "@/lib/use-toast-error";

const STATE_WORDS = { paid: "Waiting for its day", sent: "Sent", redeemed: "Redeemed", expired: "Expired", refunded: "Refunded" };

// Gift subscriptions: the switch, the gift page's link, and the gifts bought. data: list_gifts' answer.
export default function CardGifts({ newsletterId, data }) {
	const toastError = useToastError();
	const [state, action, isPending] = useActionState(async (previous, formData) => {
		const result = await saveGifts(previous, formData);
		if (result?.error) {
			toastError(result);
			return result;
		}
		toast.success("Saved");
		return { ...result, savedAt: Date.now() };
	}, null);
	const { settings, gifts } = data;

	return (
		<form key={state?.savedAt ?? 0} action={action} onSubmit={submitKeepingFields(action)}>
			<input type="hidden" name="newsletterId" value={newsletterId} />
			<CardSettings
				title="Gift subscriptions"
				stagger={1}
				action={
					<GatePlan reason="sell">
						<Button type="submit" size="sm" disabled={isPending} className="min-w-16">
							{isPending ? <Loader2 className="animate-spin" /> : "Save"}
						</Button>
					</GatePlan>
				}
			>
				<RowSettings label="Gifts" isLabel hint="A reader pays once for 1, 3, 6 or 12 months for someone else, who gets an email on the day they choose. An unredeemed gift expires 12 months after it was bought. Needs the paid tier on.">
					<span className="flex items-center gap-2.5 py-2 text-sm">
						<input type="checkbox" name="enabled" defaultChecked={settings.enabled} className="size-4 accent-foreground" />
						Readers can buy gifts
					</span>
				</RowSettings>
				{settings.giveUrl && (
					<div className="flex items-center gap-2 px-4 py-3">
						<a href={settings.giveUrl} target="_blank" rel="noreferrer" className="flex min-w-0 items-center gap-1.5 truncate font-mono text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground">
							<ExternalLink className="size-3.5 shrink-0" />
							<span className="truncate">{settings.giveUrl}</span>
						</a>
						<ButtonCopy value={settings.giveUrl} label="Copy link" />
					</div>
				)}
				{gifts.length === 0 ? (
					<p className="px-4 py-3 text-sm text-muted-foreground">No gifts yet.</p>
				) : (
					gifts.map((gift) => (
						<div key={gift.id} className="px-4 py-3 text-sm">
							<p className="font-medium">
								{gift.months} {gift.months === 1 ? "month" : "months"} of {gift.tierName} for {gift.recipientEmail}
							</p>
							<p className="text-muted-foreground tabular-nums">
								{STATE_WORDS[gift.status]}, from {gift.buyerEmail}, {formatPrice(gift.amountCents, gift.currency)}.
								{gift.status === "paid" || gift.status === "sent" ? ` Expires ${new Date(gift.expiresAt).toLocaleDateString()}.` : ""}
								{gift.deliveryError ? ` The email didn't go out: ${gift.deliveryError}.` : ""}
							</p>
						</div>
					))
				)}
			</CardSettings>
			{state?.error && <p className="mt-2 text-sm text-destructive">{state.error}</p>}
		</form>
	);
}
