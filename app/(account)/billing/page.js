import { redirect } from "next/navigation";
import { CreditCard } from "lucide-react";
import { choosePlan, openBillingPortal } from "@/app/(account)/billing/actions";
import BannerUsage from "@/components/BannerUsage";
import CardDedicatedIp from "@/components/CardDedicatedIp";
import CardSentWith from "@/components/CardSentWith";
import CardExtraEmails from "@/components/CardExtraEmails";
import CardSubscription from "@/components/CardSubscription";
import CardUsage from "@/components/CardUsage";
import HeaderPage from "@/components/HeaderPage";
import ListPricing from "@/components/ListPricing";
import NoticeWelcomePaused from "@/components/NoticeWelcomePaused";
import StateEmpty from "@/components/StateEmpty";
import { Button } from "@/components/ui/button";
import { getWelcomePauseNotice, isPaidStatus } from "@/lib/account-state";
import { requirePersonalAccount } from "@/lib/auth";
import { getBillingProviderName, hasBillingCustomer, isBillingConfigured } from "@/lib/billing-provider";
import { isCloud } from "@/lib/config";
import { getLapsedPlan } from "@/lib/free-plan";
import { getRecommendedPlanId } from "@/lib/onboarding";
import { FREE_PLAN, PLANS, getAccountPlan, isOnFreePlan, isOnFreeTier, readInterval } from "@/lib/plans";
import { getUsage, hasWelcomeEmailsOn } from "@/lib/usage";
import { cn } from "@/lib/utils";

export const metadata = { title: "Billing" };

// The account's plan with its usage, and the plans as the pricing page shows them, Free first, on the account's own. An
// account on Free, on a plan an admin gave or whose plan lapsed subscribes through Checkout, the same flow as a first
// purchase; a paid plan's changes, and the way back to Free, are confirmed with the billing provider.
export default async function BillingPage({ searchParams }) {
	const { account } = await requirePersonalAccount();
	if (!isCloud()) return <PageBillingOff />;
	const params = await searchParams;
	const isPaid = isPaidStatus(account.subscriptionStatus);
	if (isPaid && params.checkout === "pending") redirect("/");
	const interval = readInterval(params.interval ?? account.interval);
	const lapsedPlan = getLapsedPlan(account);
	const notice = getNotice({ account, isPaid, lapsedPlan, ...params });

	// The action definitions (their schemas are 500 KB of zod) load here and on the API's billing calls, not with every page.
	const { getDedicatedIpOutput, getExtraEmailsOutput } = await import("@/lib/actions/billing");
	const [usage, extraEmails, dedicatedIp] = await Promise.all([getUsage(account), getExtraEmailsOutput(account), getDedicatedIpOutput(account)]);
	const isWelcomePaused = usage.welcomeEmailsPaused && (await hasWelcomeEmailsOn(account._id));
	const isGifted = isOnFreePlan(account);
	const showsDedicatedIp = dedicatedIp.available || dedicatedIp.subscription || dedicatedIp.isOn;
	const planId = getAccountPlan(account).id;
	const current = isPaid ? { plan: account.plan, interval: readInterval(account.interval) } : { plan: planId };
	return (
		<>
			{params.checkout === "pending" && !isPaid && <meta httpEquiv="refresh" content="3" />}
			<HeaderPage title="Billing">
				{hasBillingCustomer(account) && (
					<form action={openBillingPortal}>
						<Button type="submit" variant="outline">
							<CreditCard data-icon="inline-start" />
							Manage billing
						</Button>
					</form>
				)}
			</HeaderPage>
			{notice && <TextNotice {...notice} className="mb-6" />}
			<div className="flex flex-col gap-8">
				<CardSubscription account={account} />
				<section style={{ "--stagger": 1 }} className="flex flex-col gap-3 animate-enter">
					<h2 className="text-sm font-medium text-muted-foreground">This month</h2>
					{isWelcomePaused && (
						<NoticeWelcomePaused {...getWelcomePauseNotice(usage)} hasUpgradeLink={false} className="rounded-xl px-4 py-3" />
					)}
					<BannerUsage usage={usage} hasUpgradeLink={false} />
					<CardUsage usage={usage} />
				</section>
				{extraEmails.available && (
					<section style={{ "--stagger": 2 }} className="flex flex-col gap-3 animate-enter">
						<h2 className="text-sm font-medium text-muted-foreground">Extra emails</h2>
						<CardExtraEmails extraEmails={extraEmails} planEmails={usage.emailsLimit} />
					</section>
				)}
				{showsDedicatedIp && (
					<section style={{ "--stagger": 2 }} className="flex flex-col gap-3 animate-enter">
						<h2 className="text-sm font-medium text-muted-foreground">Add-ons</h2>
						<CardDedicatedIp dedicatedIp={dedicatedIp} isPending={params.addon === "dedicated_ip"} />
					</section>
				)}
				{!isOnFreeTier(account) && (
					<section style={{ "--stagger": 2 }} className="flex flex-col gap-3 animate-enter">
						<h2 className="text-sm font-medium text-muted-foreground">Sent with FlockStack</h2>
						<CardSentWith enabled={account.sentWithLink === true} />
					</section>
				)}
				<section style={{ "--stagger": 3 }} className="flex flex-col gap-3 animate-enter">
					<div className="flex flex-col gap-1">
						<h2 className="text-sm font-medium text-muted-foreground">{isPaid ? "Change plan" : "Plans"}</h2>
						{isGifted && <p className="text-sm text-pretty text-muted-foreground">A paid plan takes over from your free plan.</p>}
						{!isPaid && !isGifted && (
							<p className="text-sm text-pretty text-muted-foreground">
								You&apos;re on Free. Upgrade for more subscribers and emails, and to take the &ldquo;Sent with FlockStack&rdquo; link off your emails and website.
								Everything you made stays when you do, and if you cancel later.
							</p>
						)}
					</div>
					<ListPricing
						initialPlanId={isPaid || isGifted ? planId : getUpgradePlanId(account)}
						initialPeriod={interval}
						current={current}
						action={isPaid ? choosePlan : undefined}
						ctaLabel="Upgrade"
					/>
				</section>
			</div>
		</>
	);
}

// Where the slider starts for an account on Free: the plan its list fits, else the first paid one, so Upgrade is in sight.
function getUpgradePlanId(account) {
	const recommended = getRecommendedPlanId(account);
	return recommended === FREE_PLAN.id ? PLANS[0].id : recommended;
}

function PageBillingOff() {
	return (
		<>
			<HeaderPage title="Billing" />
			<StateEmpty icon={CreditCard} title="Billing is off on this server">
				<p className="max-w-sm text-sm text-pretty text-muted-foreground">
					Every account has every feature, without plan limits on emails or subscribers.
				</p>
			</StateEmpty>
		</>
	);
}

function getNotice({ account, isPaid, lapsedPlan, checkout, error }) {
	const provider = getBillingProviderName();
	if (error === "none") return { tone: "error", text: "Plans can't be bought yet. Try again later." };
	if (error === "stripe" || error === "polar") return { tone: "error", text: `${provider} can't be reached right now. Try again in a minute.` };
	if (error === "rate_limited") return { tone: "error", text: `You opened ${provider} too many times in the last hour. Try again later.` };
	if (checkout === "pending") return { tone: "info", text: "Payment received. Your plan turns on in a few seconds." };
	if (!isPaid && !isBillingConfigured()) return { tone: "info", text: "Plans can't be bought yet. Check back soon." };
	if (lapsedPlan) {
		return { tone: "info", text: `Your ${lapsedPlan.name} plan ended, so you're on Free. Your newsletter, contacts and campaigns are kept: upgrade to get your ${lapsedPlan.name} limits back.` };
	}
	if (!isPaid && account.comp?.plan && !isOnFreePlan(account)) {
		return { tone: "info", text: "Your free plan from FlockStack ended, so you're on Free. Your newsletter, contacts and campaigns are kept." };
	}
	return null;
}

function TextNotice({ tone, text, className }) {
	return (
		<p
			role={tone === "error" ? "alert" : "status"}
			className={cn(
				"rounded-xl px-4 py-3 text-sm text-pretty animate-enter",
				tone === "error" ? "bg-destructive/10 text-destructive" : "bg-muted text-foreground",
				className
			)}
		>
			{text}
		</p>
	);
}
