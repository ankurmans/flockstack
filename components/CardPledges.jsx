"use client";

import { useActionState, useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { savePledges, startPledgeCharging, stopPledgeCharging } from "@/app/(app)/payments/actions";
import CardSettings, { RowSettings } from "@/components/CardSettings";
import GatePlan from "@/components/GatePlan";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCount } from "@/lib/format";
import { formatPrice } from "@/lib/payments/config";
import { submitKeepingFields } from "@/lib/submit-keeping-fields";
import { toast } from "@/lib/toast";
import { useToastError } from "@/lib/use-toast-error";

const STATUS_WORDS = {
	notifying: "Emailing each pledger the day of their first charge",
	waiting: "Waiting for the charge day",
	charging: "Charging",
	done: "Done",
	canceled: "Stopped",
	failed: "Stopped by an error",
};

// Pledges: readers who promised a price and saved a card, charged nothing. report: get_pledge_report's answer; charging:
// get_pledge_charging's (or null); isPaidOn: the paid tier is open, which is what charging needs.
export default function CardPledges({ newsletterId, report, charging, isPaidOn }) {
	const toastError = useToastError();
	const [isConfirming, setIsConfirming] = useState(false);
	const [isStopping, startStopping] = useTransition();
	const [state, action, isPending] = useActionState(async (previous, formData) => {
		const result = await savePledges(previous, formData);
		if (result?.error) {
			toastError(result);
			return result;
		}
		toast.success("Saved");
		return { ...result, savedAt: Date.now() };
	}, null);
	const [chargeState, chargeAction, isCharging] = useActionState(async (previous, formData) => {
		const result = await startPledgeCharging(previous, formData);
		if (result?.error) {
			toastError(result);
			return result;
		}
		toast.success("Telling your pledgers");
		setIsConfirming(false);
		return result;
	}, null);
	const { settings } = report;
	const isRunning = charging && ["notifying", "waiting", "charging"].includes(charging.status);

	return (
		<div className="flex flex-col gap-6">
			<form key={state?.savedAt ?? 0} action={action} onSubmit={submitKeepingFields(action)}>
				<input type="hidden" name="newsletterId" value={newsletterId} />
				<CardSettings
					title="Pledges"
					stagger={1}
					action={
						<GatePlan reason="sell">
							<Button type="submit" size="sm" disabled={isPending} className="min-w-16">
								{isPending ? <Loader2 className="animate-spin" /> : "Save"}
							</Button>
						</GatePlan>
					}
				>
					<RowSettings label="Pledges" isLabel hint="For a newsletter that isn't taking payments yet: readers pledge a price and save a card. Nothing is charged, and they get no paid access, until you start charging.">
						<span className="flex items-center gap-2.5 py-2 text-sm">
							<input type="checkbox" name="enabled" defaultChecked={settings.enabled} className="size-4 accent-foreground" />
							Readers can pledge
						</span>
					</RowSettings>
					<RowSettings label="Notice" isLabel hint="Days before the first charge that each pledger is emailed, with a link to cancel.">
						<Input name="noticeDays" inputMode="numeric" defaultValue={settings.noticeDays} className="w-28" />
					</RowSettings>
					<div className="px-4 py-3 text-sm text-muted-foreground">
						{report.pledges === 0 ? (
							"No pledges yet."
						) : (
							<>
								<p className="tabular-nums">
									{formatCount(report.pledges, "pledge")}, {formatPrice(report.perMonthCents, report.currency)} a month in all.
								</p>
								<ul className="mt-2 flex flex-col gap-0.5 tabular-nums">
									{report.tiers
										.filter((tier) => tier.pledges > 0)
										.map((tier) => (
											<li key={tier.tierId}>
												{tier.name}: {formatCount(tier.pledges, "pledge")}, {formatPrice(tier.perMonthCents, report.currency)} a month
											</li>
										))}
								</ul>
							</>
						)}
					</div>
				</CardSettings>
				{state?.error && <p className="mt-2 text-sm text-destructive">{state.error}</p>}
			</form>

			<CardSettings title="Start charging" stagger={2}>
				{isRunning ? (
					<div className="flex flex-col gap-2 px-4 py-3 text-sm">
						<p className="tabular-nums">
							{STATUS_WORDS[charging.status]}: {charging.notified} of {charging.total} told, {charging.converted} subscribed
							{charging.failed > 0 ? `, ${charging.failed} failed` : ""}. First charge on {new Date(charging.chargeAt).toLocaleDateString()}.
						</p>
						{charging.status !== "charging" && (
							<Button
								type="button"
								variant="outline"
								size="sm"
								className="self-start"
								disabled={isStopping}
								onClick={() =>
									startStopping(async () => {
										const result = await stopPledgeCharging(newsletterId);
										if (result?.error) toastError(result);
									})
								}
							>
								Stop before the charge day
							</Button>
						)}
					</div>
				) : (
					<form action={chargeAction} className="flex flex-col gap-3 px-4 py-3 text-sm">
						<input type="hidden" name="newsletterId" value={newsletterId} />
						<input type="hidden" name="noticeDays" value={settings.noticeDays} />
						<p className="text-muted-foreground text-pretty">
							{isPaidOn
								? `Every pledger gets an email now with the day of their first charge, ${settings.noticeDays} days from today, and a link to cancel. On that day their cards are charged and they become paid subscribers.`
								: "Turn on the paid tier above first: pledgers are charged for it."}
						</p>
						<span className="flex items-center gap-2.5">
							<input type="checkbox" name="honorPledgedPrice" defaultChecked className="size-4 accent-foreground" />
							Charge what each pledged, not the tier&apos;s price now
						</span>
						{charging && charging.status === "done" && (
							<p className="text-muted-foreground tabular-nums">
								Last time: {charging.converted} subscribed{charging.failed > 0 ? `, ${charging.failed} failed` : ""}.
							</p>
						)}
						{isConfirming ? (
							<span className="flex items-center gap-2">
								<Button type="submit" size="sm" disabled={isCharging || !isPaidOn || report.pledges === 0}>
									{isCharging ? <Loader2 className="animate-spin" /> : `Yes, email ${formatCount(report.pledges, "pledger")}`}
								</Button>
								<Button type="button" variant="ghost" size="sm" onClick={() => setIsConfirming(false)}>
									Not yet
								</Button>
							</span>
						) : (
							<Button type="button" size="sm" className="self-start" disabled={!isPaidOn || report.pledges === 0} onClick={() => setIsConfirming(true)}>
								Start charging
							</Button>
						)}
						{chargeState?.error && <p className="text-destructive">{chargeState.error}</p>}
					</form>
				)}
			</CardSettings>
		</div>
	);
}
