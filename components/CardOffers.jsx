"use client";

import { useActionState, useState, useTransition } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { removeOffer, saveBanner, saveOffer, switchOffer } from "@/app/(app)/payments/actions";
import ButtonCopy from "@/components/ButtonCopy";
import CardSettings, { RowSettings } from "@/components/CardSettings";
import GatePlan from "@/components/GatePlan";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCount } from "@/lib/format";
import { submitKeepingFields } from "@/lib/submit-keeping-fields";
import { toast } from "@/lib/toast";
import { useToastError } from "@/lib/use-toast-error";

const STATUS_WORDS = { live: "Live", inactive: "Switched off", ended: "Ended", used_up: "Used up" };

// Offers: discounts and trials with a link, and the launch banner. data: list_offers' answer.
export default function CardOffers({ newsletterId, data }) {
	const toastError = useToastError();
	const [isWorking, startWorking] = useTransition();
	const [type, setType] = useState("percent");
	const [duration, setDuration] = useState("once");
	const [state, action, isPending] = useActionState(async (previous, formData) => {
		const result = await saveOffer(previous, formData);
		if (result?.error) {
			toastError(result);
			return result;
		}
		toast.success("Offer made");
		return { ...result, savedAt: Date.now() };
	}, null);
	const [bannerState, bannerAction, isSavingBanner] = useActionState(async (previous, formData) => {
		const result = await saveBanner(previous, formData);
		if (result?.error) {
			toastError(result);
			return result;
		}
		toast.success("Saved");
		return { ...result, savedAt: Date.now() };
	}, null);

	function run(work) {
		startWorking(async () => {
			const result = await work();
			if (result?.error) toastError(result);
		});
	}

	return (
		<div className="flex flex-col gap-6">
			<CardSettings title="Offers" stagger={1}>
				{data.offers.length === 0 && <p className="px-4 py-3 text-sm text-muted-foreground">No offers yet. An offer is a discount or a trial with a link you can share.</p>}
				{data.offers.map((offer) => (
					<div key={offer.id} className="flex flex-col gap-1.5 px-4 py-3 text-sm">
						<div className="flex items-center justify-between gap-3">
							<span className="font-medium">
								{offer.name} <span className="font-normal text-muted-foreground">· {STATUS_WORDS[offer.status]}</span>
							</span>
							<span className="flex items-center gap-1">
								<Button type="button" variant="ghost" size="sm" disabled={isWorking} onClick={() => run(() => switchOffer(offer.id, !offer.active))}>
									{offer.active ? "Switch off" : "Switch on"}
								</Button>
								<Button type="button" variant="ghost" size="icon-sm" disabled={isWorking} onClick={() => run(() => removeOffer(offer.id))} aria-label={`Delete ${offer.name}`}>
									<Trash2 />
								</Button>
							</span>
						</div>
						<p className="text-muted-foreground tabular-nums">
							{offer.summary}. {formatCount(offer.redemptions, "reader")} took it, {offer.payingNow} paid now
							{offer.maxRedemptions ? `, limit ${offer.maxRedemptions}` : ""}
							{offer.expiresAt ? `, until ${new Date(offer.expiresAt).toLocaleDateString()}` : ""}.
						</p>
						{offer.url && (
							<span className="flex items-center gap-2">
								<span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{offer.url}</span>
								<ButtonCopy value={offer.url} label="Copy link" />
							</span>
						)}
					</div>
				))}
			</CardSettings>

			<form key={state?.savedAt ?? 0} action={action} onSubmit={submitKeepingFields(action)}>
				<input type="hidden" name="newsletterId" value={newsletterId} />
				<CardSettings
					title="New offer"
					stagger={2}
					action={
						<GatePlan reason="sell">
							<Button type="submit" size="sm" disabled={isPending} className="min-w-16">
								{isPending ? <Loader2 className="animate-spin" /> : "Make"}
							</Button>
						</GatePlan>
					}
				>
					<RowSettings label="Name" isLabel hint="Readers see it on Stripe's page.">
						<Input name="name" maxLength={60} placeholder="e.g. Launch week" required />
					</RowSettings>
					<RowSettings label="Kind" isLabel>
						<select name="type" value={type} onChange={(event) => setType(event.target.value)} className="h-9 w-48 rounded-lg border border-input bg-transparent px-2 text-sm">
							<option value="percent">Percent off</option>
							<option value="amount">Amount off</option>
							<option value="trial">Trial</option>
						</select>
					</RowSettings>
					{type !== "trial" && (
						<RowSettings label={type === "percent" ? "Percent" : "Amount"} isLabel hint={type === "percent" ? "1 to 100." : "In the newsletter's currency."}>
							<Input name="value" inputMode="decimal" placeholder={type === "percent" ? "e.g. 20" : "e.g. 5"} className="w-32" />
						</RowSettings>
					)}
					{type !== "trial" && (
						<RowSettings label="For how long" isLabel>
							<span className="flex items-center gap-2">
								<select name="duration" value={duration} onChange={(event) => setDuration(event.target.value)} className="h-9 w-48 rounded-lg border border-input bg-transparent px-2 text-sm">
									<option value="once">The first payment</option>
									<option value="repeating">Some months</option>
									<option value="forever">Every payment</option>
								</select>
								{duration === "repeating" && <Input name="durationMonths" inputMode="numeric" defaultValue="3" aria-label="Months" className="w-20" />}
							</span>
						</RowSettings>
					)}
					<RowSettings label="Trial days" isLabel hint={type === "trial" ? "Days. Needed for a trial." : "Days of free trial for readers who take it. Empty for none."}>
						<Input name="trialDays" inputMode="numeric" placeholder="e.g. 14" className="w-28" />
					</RowSettings>
					{type === "trial" && <RowSettings label="Trial charge" isLabel hint="One-time amount due now, in the newsletter’s currency. Empty or zero is free. A paid trial always requires a card, then renews at the regular plan price."><Input name="trialAmount" inputMode="decimal" placeholder="e.g. 1.00" className="w-28" /></RowSettings>}
					<RowSettings label="Limit" isLabel hint={type === "trial" ? "Checks confirmed readers before opening checkout. Concurrent checkouts can exceed this limit. Empty for no limit." : "Stop after this many readers. Empty for no limit."}>
						<Input name="maxRedemptions" inputMode="numeric" className="w-28" />
					</RowSettings>
					<RowSettings label="Ends on" isLabel hint="Empty for no end.">
						<Input name="expiresAt" type="date" className="w-44" />
					</RowSettings>
				</CardSettings>
				{state?.error && <p className="mt-2 text-sm text-destructive">{state.error}</p>}
			</form>

			<form key={`b${bannerState?.savedAt ?? 0}`} action={bannerAction} onSubmit={submitKeepingFields(bannerAction)}>
				<input type="hidden" name="newsletterId" value={newsletterId} />
				<CardSettings
					title="Launch offer banner"
					stagger={3}
					action={
						<GatePlan reason="sell">
							<Button type="submit" size="sm" disabled={isSavingBanner} className="min-w-16">
								{isSavingBanner ? <Loader2 className="animate-spin" /> : "Save"}
							</Button>
						</GatePlan>
					}
				>
					<RowSettings label="Banner" isLabel hint="A line above your website while the paid tier is open. It hides itself when the offer ends.">
						<span className="flex items-center gap-2.5 py-2 text-sm">
							<input type="checkbox" name="enabled" defaultChecked={data.banner.enabled} className="size-4 accent-foreground" />
							Show the banner
						</span>
					</RowSettings>
					<RowSettings label="Text" isLabel>
						<Input name="text" defaultValue={data.banner.text} maxLength={120} placeholder="e.g. Launch week: 20% off for 3 months" />
					</RowSettings>
					<RowSettings label="Links to" isLabel>
						<select name="offer" defaultValue={data.banner.offerId ?? ""} className="h-9 rounded-lg border border-input bg-transparent px-2 text-sm">
							<option value="">The subscribe page</option>
							{data.offers.map((offer) => (
								<option key={offer.id} value={offer.id}>
									{offer.name}
								</option>
							))}
						</select>
					</RowSettings>
				</CardSettings>
			</form>
		</div>
	);
}
