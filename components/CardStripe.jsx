import { ArrowUpRight } from "lucide-react";
import { connectStripe } from "@/app/(app)/payments/actions";
import ButtonRefreshPayments from "@/components/ButtonRefreshPayments";
import CardSettings, { RowSettings } from "@/components/CardSettings";
import GatePlan from "@/components/GatePlan";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Where the account is paid. status: get_payments_status's answer.
export default function CardStripe({ status }) {
	const isConnect = status.mode === "connect";

	return (
		<CardSettings
			title="Stripe"
			action={isConnect && status.connected && <ButtonRefreshPayments />}
		>
			{status.mode === "none" && (
				<p className="px-4 py-3 text-sm text-pretty text-muted-foreground">
					Payments aren&apos;t set up on this server. Set <span className="font-mono text-xs">STRIPE_SECRET_KEY</span> to take payments for products and paid subscriptions.
				</p>
			)}
			{status.mode === "direct" && (
				<p className="px-4 py-3 text-sm text-pretty text-muted-foreground">
					This server charges with its own Stripe key, so sales go to that Stripe account. Nothing to connect.
				</p>
			)}
			{isConnect && (
				<>
					<RowSettings label="Account">
						<span className="flex flex-wrap items-center justify-between gap-3 text-sm">
							<Dot tone={status.ready ? "good" : status.connected ? "wait" : "none"}>
								{status.ready ? "Connected, ready for payments" : status.problem}
							</Dot>
							<span className="flex items-center gap-2">
								<GatePlan reason="sell">
									<form action={connectStripe}>
										<Button type="submit" variant={status.ready ? "outline" : "default"}>
											{status.ready ? "Update details" : status.connected ? "Continue setup" : "Connect Stripe"}
										</Button>
									</form>
								</GatePlan>
								{status.connected && (
									<Button asChild variant="outline">
										<a href="https://dashboard.stripe.com" target="_blank" rel="noreferrer">
											Stripe dashboard
											<ArrowUpRight data-icon="inline-end" className="opacity-60" />
										</a>
									</Button>
								)}
							</span>
						</span>
					</RowSettings>
					{status.connected && (
						<>
							<RowSettings label="Charges">
								<Dot tone={status.chargesEnabled ? "good" : "wait"}>{status.chargesEnabled ? "Can take payments" : "Stripe hasn't enabled payments yet"}</Dot>
							</RowSettings>
							<RowSettings label="Payouts">
								<Dot tone={status.payoutsEnabled ? "good" : "wait"}>{status.payoutsEnabled ? "Paid out to your bank" : "Add a bank account in Stripe to get paid out"}</Dot>
							</RowSettings>
						</>
					)}
				</>
			)}
			<p className="px-4 py-3 text-xs text-pretty text-muted-foreground">
				FlockStack takes no cut of your sales. Readers pay your own Stripe account, and only Stripe&apos;s processing fee comes off. Refunds, disputes and payouts are handled in your Stripe dashboard.
			</p>
		</CardSettings>
	);
}

const DOT_TONES = {
	good: "bg-emerald-500",
	wait: "bg-amber-500",
	none: "bg-zinc-300 dark:bg-zinc-600",
};

function Dot({ tone, children }) {
	return (
		<span className="flex items-center gap-2 text-sm text-muted-foreground">
			<span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", DOT_TONES[tone])} />
			{children}
		</span>
	);
}
