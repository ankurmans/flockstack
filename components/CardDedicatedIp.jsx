import { Server } from "lucide-react";
import { addDedicatedIp } from "@/app/(account)/billing/actions";
import { Button } from "@/components/ui/button";
import { formatDate, formatUsd } from "@/lib/format";
import { DEDICATED_IP_AT_COST, DEDICATED_IP_DETAILS, DEDICATED_IP_PRICE } from "@/lib/plans";

// The dedicated IP add-on on the billing page (get_billing's dedicatedIp), for Pro and above. isPending: back from
// Polar's checkout, before the add-on is on.
export default function CardDedicatedIp({ dedicatedIp, isPending = false }) {
	const { isOn, state, address, warmup, available, price, subscription } = dedicatedIp;
	const isPaid = subscription && ["active", "trialing", "past_due"].includes(subscription.status);
	const per = "a month";

	return (
		<div className="flex flex-col gap-4 rounded-xl bg-card p-4 shadow-border sm:flex-row sm:items-start sm:justify-between sm:p-5">
			<div className="flex min-w-0 gap-3">
				<Server aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
				<div className="flex min-w-0 flex-col gap-1">
					<p className="font-medium">{isOn ? "Dedicated IP" : "Add a dedicated IP"}</p>
					<p className="max-w-xl text-sm text-pretty text-muted-foreground">{DEDICATED_IP_AT_COST}</p>
					<p className="max-w-xl text-sm text-pretty text-muted-foreground">{DEDICATED_IP_DETAILS}</p>
					<p className="text-sm text-muted-foreground tabular-nums">{getStatus({ isOn, state, address, warmup, isPaid, isPending, price, per, subscription })}</p>
				</div>
			</div>
			{available && !isPaid && (
				<form action={addDedicatedIp} className="shrink-0">
					<Button type="submit" className="w-full sm:w-auto">
						Add for {formatUsd(price ?? DEDICATED_IP_PRICE)}/month
					</Button>
				</form>
			)}
		</div>
	);
}

function getStatus({ isOn, state, address, warmup, isPaid, isPending, price, per, subscription }) {
	if (isPaid && subscription.cancelAt) return `${isOn ? "On" : "Paid"} until ${formatDate(subscription.cancelAt)}, then back to shared IPs.`;
	if (state === "warming" && warmup) {
		const held = warmup.isHeld ? " Today is held while bounces or complaints settle, or too little was sent." : "";
		return `Warming up: day ${warmup.day} of ${warmup.days}, ${formatShare(warmup.share)}% of your email goes through your IP.${held}`;
	}
	if (state === "active") return `Active${address ? `: ${address}` : ""}. All of your email goes through your IP.${price && isPaid ? ` ${formatUsd(price)} ${per}, managed from Manage billing.` : ""}`;
	if (state === "waiting" || isPaid || isPending) return "Payment received. Your IP is being prepared, usually within 2 business days. It starts warming up by itself.";
	if (isOn) return "On, set up by FlockStack.";
	return price ? `${formatUsd(price)} ${per}, on top of your plan. It is set up once paid.` : null;
}

function formatShare(share) {
	return Number.isInteger(share) ? share : share.toFixed(1);
}
