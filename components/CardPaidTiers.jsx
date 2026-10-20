"use client";

import { useActionState, useState, useTransition } from "react";
import { ArrowDown, ArrowUp, Loader2, Plus, Trash2 } from "lucide-react";
import { deleteTier, moveTier, saveTier } from "@/app/(app)/payments/actions";
import CardSettings, { RowSettings } from "@/components/CardSettings";
import GatePlan from "@/components/GatePlan";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatCount } from "@/lib/format";
import { submitKeepingFields } from "@/lib/submit-keeping-fields";
import { toast } from "@/lib/toast";
import { useToastError } from "@/lib/use-toast-error";

const toInput = (cents) => (cents > 0 ? (cents / 100).toFixed(2).replace(/\.00$/, "") : "");

// The newsletter's paid tiers, lowest first: each one's name, benefits and prices, and a form to add another (3 at most).
// tiers: list_paid_tiers' answer.
export default function CardPaidTiers({ newsletterId, tiers }) {
	const toastError = useToastError();
	const [isMoving, startMoving] = useTransition();
	const ids = tiers.map((tier) => tier.id);

	function move(from, to) {
		const next = [...ids];
		next.splice(to, 0, next.splice(from, 1)[0]);
		startMoving(async () => {
			const result = await moveTier(newsletterId, next);
			if (result?.error) toastError(result);
		});
	}

	return (
		<div className="flex flex-col gap-6">
			{tiers.map((tier, index) => (
				<FormTier key={`${tier.id}-${tier.name}`} newsletterId={newsletterId} tier={tier}>
					{tiers.length > 1 && (
						<span className="flex gap-1">
							<Button type="button" variant="ghost" size="icon-sm" disabled={isMoving || index === 0} onClick={() => move(index, index - 1)} aria-label={`Move ${tier.name} down a tier`}>
								<ArrowDown />
							</Button>
							<Button type="button" variant="ghost" size="icon-sm" disabled={isMoving || index === tiers.length - 1} onClick={() => move(index, index + 1)} aria-label={`Move ${tier.name} up a tier`}>
								<ArrowUp />
							</Button>
						</span>
					)}
				</FormTier>
			))}
			{tiers.length < 3 && <NewTier newsletterId={newsletterId} isFirst={tiers.length === 0} />}
		</div>
	);
}

function NewTier({ newsletterId, isFirst }) {
	const [isOpen, setIsOpen] = useState(isFirst);
	if (!isOpen) {
		return (
			<Button type="button" variant="outline" onClick={() => setIsOpen(true)} className="self-start">
				<Plus data-icon="inline-start" />
				Add a paid tier
			</Button>
		);
	}
	return <FormTier newsletterId={newsletterId} tier={null} />;
}

function FormTier({ newsletterId, tier, children }) {
	const toastError = useToastError();
	const [isDeleting, startDeleting] = useTransition();
	const [state, action, isPending] = useActionState(async (previous, formData) => {
		const result = await saveTier(previous, formData);
		if (result?.error) {
			toastError(result);
			return result;
		}
		toast.success("Saved");
		return { ...result, savedAt: Date.now() };
	}, null);

	function remove() {
		startDeleting(async () => {
			const result = await deleteTier(newsletterId, tier.id);
			if (result?.error) toastError(result);
			else toast.success("Tier deleted");
		});
	}

	return (
		<form key={state?.savedAt ?? 0} action={action} onSubmit={submitKeepingFields(action)}>
			<input type="hidden" name="newsletterId" value={newsletterId} />
			{tier && <input type="hidden" name="tierId" value={tier.id} />}
			<CardSettings
				title={tier ? `${tier.name}${tier.archived ? " (archived)" : ""}` : "New paid tier"}
				stagger={1}
				action={
					<span className="flex items-center gap-1">
						{children}
						{tier && (
							<Button type="button" variant="ghost" size="icon-sm" disabled={isDeleting} onClick={remove} aria-label={`Delete ${tier.name}`}>
								<Trash2 />
							</Button>
						)}
						<GatePlan reason="sell">
							<Button type="submit" size="sm" disabled={isPending} className="min-w-16">
								{isPending ? <Loader2 className="animate-spin" /> : tier ? "Save" : "Add"}
							</Button>
						</GatePlan>
					</span>
				}
			>
				<RowSettings label="Name" isLabel>
					<Input name="name" defaultValue={tier?.name} maxLength={60} placeholder="e.g. Supporter" required />
				</RowSettings>
				<RowSettings label="Description" isLabel hint="A line or two on who it is for.">
					<Textarea name="description" defaultValue={tier?.description} maxLength={300} rows={2} />
				</RowSettings>
				<RowSettings label="Benefits" isLabel hint="One per line, 10 at most.">
					<Textarea name="benefits" defaultValue={tier?.benefits.join("\n")} rows={3} />
				</RowSettings>
				<RowSettings label="Monthly" isLabel hint="Leave a price empty to not offer that plan.">
					<Input name="monthly" inputMode="decimal" defaultValue={toInput(tier?.monthlyCents)} placeholder="e.g. 8" className="w-32" />
				</RowSettings>
				<RowSettings label="Quarterly" isLabel hint="Every 3 months.">
					<Input name="quarterly" inputMode="decimal" defaultValue={toInput(tier?.quarterlyCents)} placeholder="e.g. 22" className="w-32" />
				</RowSettings>
				<RowSettings label="Yearly" isLabel>
					<Input name="yearly" inputMode="decimal" defaultValue={toInput(tier?.yearlyCents)} placeholder="e.g. 80" className="w-32" />
				</RowSettings>
				<RowSettings label="Lifetime" isLabel hint="One payment that never renews.">
					<Input name="lifetime" inputMode="decimal" defaultValue={toInput(tier?.lifetimeCents)} placeholder="e.g. 300" className="w-32" />
				</RowSettings>
				<RowSettings label="Pay what you want" isLabel hint="Readers name the price, this much or more. Empty to not offer it.">
					<span className="flex items-center gap-2">
						<Input name="pwyw" inputMode="decimal" defaultValue={toInput(tier?.payWhatYouWant?.minCents ?? 0)} placeholder="Least, e.g. 5" className="w-32" />
						<select name="pwywInterval" defaultValue={tier?.payWhatYouWant?.interval ?? "year"} aria-label="Billed" className="h-9 rounded-lg border border-input bg-transparent px-2 text-sm">
							<option value="month">a month</option>
							<option value="year">a year</option>
						</select>
					</span>
				</RowSettings>
				<RowSettings label="Founding tier" isLabel hint="The same content for more money, shown as a way to back the writer. Readers can give a name for the supporters list.">
					<span className="flex flex-wrap items-center gap-3 py-2 text-sm">
						<span className="flex items-center gap-2.5">
							<input type="checkbox" name="founding" defaultChecked={tier?.founding.enabled} className="size-4 accent-foreground" />
							Founding tier
						</span>
						<Input name="foundingCap" inputMode="numeric" defaultValue={tier?.founding.cap ?? ""} placeholder="Limit" aria-label="Founding member limit" className="w-24" />
					</span>
				</RowSettings>
				{tier && (
					<RowSettings label="Hidden" isLabel hint="Archived tiers leave the subscribe page. Readers who hold one keep it.">
						<span className="flex items-center gap-2.5 py-2 text-sm">
							<input type="checkbox" name="archived" defaultChecked={tier.archived} className="size-4 accent-foreground" />
							Archived
						</span>
					</RowSettings>
				)}
				{tier && (
					<p className="px-4 py-3 text-sm text-muted-foreground tabular-nums">
						{formatCount(tier.readers.paid, "paid reader")}
						{tier.readers.comp > 0 && `, ${tier.readers.comp} on a comp`}
						{tier.readers.gift > 0 && `, ${tier.readers.gift} on a gift`}
						{tier.founding.enabled && tier.founding.cap ? `. ${tier.founding.spotsLeft} of ${tier.founding.cap} founding spots left` : ""}.
					</p>
				)}
			</CardSettings>
			{state?.error && <p className="mt-2 text-sm text-destructive">{state.error}</p>}
		</form>
	);
}
