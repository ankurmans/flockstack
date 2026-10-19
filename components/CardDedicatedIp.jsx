import { Server } from "lucide-react";
import { addDedicatedIp } from "@/app/(account)/billing/actions";
import { Button } from "@/components/ui/button";
import { formatDate, formatUsd } from "@/lib/format";

// The dedicated IP add-on on the billing page (get_billing's dedicatedIp), for Pro and above. isPending: back from
// Polar's checkout, before the add-on is on.
export default function CardDedicatedIp({ dedicatedIp, isPending = false }) {
	const { isOn, available, price, interval, subscription } = dedicatedIp;
	const isPaid = subscription && ["active", "trialing", "past_due"].includes(subscription.status);

	return (
		<div className="flex flex-col gap-4 rounded-xl bg-card p-4 shadow-border sm:flex-row sm:items-start sm:justify-between sm:p-5">
			<div className="flex min-w-0 gap-3">
				<Server aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
				<div className="flex min-w-0 flex-col gap-1">
					<p className="font-medium">{isOn ? "Dedicated IP" : "Add a dedicated IP"}</p>
					<p className="max-w-xl text-sm text-pretty text-muted-foreground">
						Your own sending IP, warmed up automatically by AWS, so other senders&apos; mail never affects yours. Best for steady volume
						above 250,000 emails a month.
					</p>
					<p className="text-sm text-muted-foreground tabular-nums">{getStatus({ isOn, isPaid, isPending, price, interval, subscription })}</p>
				</div>
			</div>
			{available && !isPaid && (
				<form action={addDedicatedIp} className="shrink-0">
					<Button type="submit" className="w-full sm:w-auto">
						Add for {formatUsd(price)}/{interval === "year" ? "year" : "month"}
					</Button>
				</form>
			)}
		</div>
	);
}

function getStatus({ isOn, isPaid, isPending, price, interval, subscription }) {
	const per = interval === "year" ? "a year" : "a month";
	if (isPaid && subscription.cancelAt) return `${isOn ? "On" : "Paid"} until ${formatDate(subscription.cancelAt)}, then back to shared IPs.`;
	if (isPaid && isOn) return `On. ${price ? `${formatUsd(price)} ${per}, ` : ""}managed from Manage billing.`;
	if (isPaid || isPending) return "Payment received. Your dedicated IP turns on in a few minutes.";
	if (isOn) return "On, set up by FlockStack.";
	return price ? `${formatUsd(price)} ${per}, on top of your plan. It turns on once paid.` : null;
}
