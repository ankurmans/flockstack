"use client";

import { useActionState, useTransition } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { giveComp, takeCompAway } from "@/app/(app)/payments/actions";
import CardSettings, { RowSettings } from "@/components/CardSettings";
import GatePlan from "@/components/GatePlan";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { submitKeepingFields } from "@/lib/submit-keeping-fields";
import { toast } from "@/lib/toast";
import { useToastError } from "@/lib/use-toast-error";

// Comp access: paid access you give a contact by hand until a day, apart from paying readers and never counted as revenue.
// comps: list_comps' answer. tiers: list_paid_tiers'.
export default function CardComps({ newsletterId, comps, tiers }) {
	const toastError = useToastError();
	const [isWorking, startWorking] = useTransition();
	const [state, action, isPending] = useActionState(async (previous, formData) => {
		const result = await giveComp(previous, formData);
		if (result?.error) {
			toastError(result);
			return result;
		}
		toast.success("Access given");
		return { ...result, savedAt: Date.now() };
	}, null);

	return (
		<div className="flex flex-col gap-6">
			<form key={state?.savedAt ?? 0} action={action} onSubmit={submitKeepingFields(action)}>
				<input type="hidden" name="newsletterId" value={newsletterId} />
				<CardSettings
					title="Comp access"
					stagger={1}
					action={
						<GatePlan reason="sell">
							<Button type="submit" size="sm" disabled={isPending} className="min-w-16">
								{isPending ? <Loader2 className="animate-spin" /> : "Give"}
							</Button>
						</GatePlan>
					}
				>
					<RowSettings label="Contact" isLabel hint="Their email. They have to be on your list already.">
						<Input name="contact" type="email" placeholder="press@example.com" required />
					</RowSettings>
					<RowSettings label="Until" isLabel hint="The last day of the access.">
						<Input name="endsAt" type="date" required className="w-44" />
					</RowSettings>
					{tiers.length > 1 && (
						<RowSettings label="Tier" isLabel>
							<select name="tier" defaultValue={tiers[0].id} className="h-9 rounded-lg border border-input bg-transparent px-2 text-sm">
								{tiers.map((tier) => (
									<option key={tier.id} value={tier.id}>
										{tier.name}
									</option>
								))}
							</select>
						</RowSettings>
					)}
					<RowSettings label="Note" isLabel hint="Only you see it.">
						<Input name="note" maxLength={200} placeholder="e.g. Reviewing the book" />
					</RowSettings>
				</CardSettings>
				{state?.error && <p className="mt-2 text-sm text-destructive">{state.error}</p>}
			</form>
			{comps.length > 0 && (
				<CardSettings title="Given by hand" stagger={2}>
					{comps.map((comp) => (
						<div key={comp.contactId} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
							<span className="min-w-0">
								<span className="block truncate font-medium">{comp.email}</span>
								<span className="block text-muted-foreground tabular-nums">
									{comp.tierName} until {new Date(comp.endsAt).toLocaleDateString()}
									{comp.note ? `, ${comp.note}` : ""}
									{comp.alsoPays ? ", also pays" : ""}
								</span>
							</span>
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								disabled={isWorking}
								aria-label={`Take away ${comp.email}'s access`}
								onClick={() =>
									startWorking(async () => {
										const result = await takeCompAway(newsletterId, comp.contactId);
										if (result?.error) toastError(result);
									})
								}
							>
								<Trash2 />
							</Button>
						</div>
					))}
				</CardSettings>
			)}
		</div>
	);
}
