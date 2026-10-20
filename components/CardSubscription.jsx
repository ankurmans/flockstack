import BadgeStatus from "@/components/BadgeStatus";
import { getAccountStatus, getBlockedMessage } from "@/lib/account-state";
import { formatDate, formatNumber } from "@/lib/format";
import { getAccountPlan, getPrice, isOnFreePlan, isOnFreeTier } from "@/lib/plans";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export default function CardSubscription({ account }) {
	const plan = getAccountPlan(account);
	const status = getAccountStatus(account);
	const details = getPlanDetails(account);
	const warning = status === "blocked" ? getBlockedMessage(account) : WARNINGS[status];

	return (
		<div className="flex flex-col gap-3 rounded-2xl bg-card p-5 shadow-border animate-enter sm:p-6">
			<div className="flex flex-wrap items-center gap-2.5">
				<h2 className="text-lg font-semibold tracking-tight">{plan.name}</h2>
				<BadgeStatus status={status} />
			</div>
			{details.length > 0 && <p className="text-sm text-muted-foreground tabular-nums">{details.join(" · ")}</p>}
			{warning && <p className="text-sm text-amber-600 dark:text-amber-400">{warning}</p>}
		</div>
	);
}

// The price and the next date, here and on the account page. A plan from an admin has its end date, if it has one.
export function getPlanDetails(account) {
	const plan = getAccountPlan(account);
	if (isOnFreePlan(account)) {
		return [`${plan.name} plan from FlockStack, at no charge`, account.comp.until && `Ends ${formatDate(account.comp.until)}`].filter(Boolean);
	}
	if (isOnFreeTier(account)) return [`${formatNumber(plan.subscribers)} subscribers`, `${formatNumber(plan.emailsPerMonth)} emails a month`, "No card needed"];
	const nextDate = account.cancelAt
		? `Ends ${formatDate(account.cancelAt)}`
		: account.currentPeriodEnd && `Renews ${formatDate(account.currentPeriodEnd)}`;
	return [`${usd.format(getPrice(plan, account.interval))} per ${account.interval}`, nextDate].filter(Boolean);
}

const WARNINGS = {
	past_due: "Your last payment failed. Update your card in billing to keep sending.",
};
