import Link from "next/link";
import { ArrowUpRight, CreditCard, Lock, Send } from "lucide-react";
import { openBillingPortal } from "@/app/(account)/billing/actions";
import AvatarUser from "@/components/AvatarUser";
import CardPasskeys from "@/components/CardPasskeys";
import BadgeStatus from "@/components/BadgeStatus";
import CardExport from "@/components/CardExport";
import CardSettings, { RowSettings } from "@/components/CardSettings";
import CardSigninMethods from "@/components/CardSigninMethods";
import { getPlanDetails } from "@/components/CardSubscription";
import DialogDeleteAccount from "@/components/DialogDeleteAccount";
import FormProfile from "@/components/FormProfile";
import HeaderPage from "@/components/HeaderPage";
import LayoutNarrow from "@/components/LayoutNarrow";
import { Button } from "@/components/ui/button";
import { DELETION_GRACE_DAYS, getDeletionBlockers } from "@/lib/account-deletion";
import { getAccountStatus } from "@/lib/account-state";
import { listSocialAccounts } from "@/lib/accounts";
import { runDashboardAction } from "@/lib/actions/dashboard";
import { isAppleEnabled, isGoogleEnabled, requireAccount } from "@/lib/auth";
import { getBillingProviderName } from "@/lib/billing-provider";
import { isCloud } from "@/lib/config";
import { formatDate } from "@/lib/format";
import { getAccountPlan, isOnFreeTier } from "@/lib/plans";
import { MAX_NAME_LENGTH } from "@/lib/profile";
import { REGION_PLACES, getRegion } from "@/lib/region";
import { SIGNIN_PROVIDERS, describeConnectResult } from "@/lib/signin-methods";

export const metadata = { title: "Account" };

const PROVIDER_ENABLED = { google: isGoogleEnabled, apple: isAppleEnabled };

// The whole account, apart from any newsletter: who signs in, billing, and deleting it. Google and Apple send people back
// here after connecting, with ?connected= or ?connect= and ?error=.
export default async function AccountPage({ searchParams } = {}) {
	const { user, account } = await requireAccount();
	const [blockers, socialAccounts, { output: latestExport }, params] = await Promise.all([
		getDeletionBlockers(account),
		listSocialAccounts(user.id),
		runDashboardAction("get_account_export", {}),
		searchParams ?? {},
	]);
	const socialSignins = socialAccounts.map(({ name }) => name);
	// A provider the server no longer has keeps its row while it's linked, so it can be unlinked.
	const methods = Object.entries(SIGNIN_PROVIDERS)
		.map(([provider, name]) => ({ provider, name, account: socialAccounts.find((item) => item.provider === provider) ?? null }))
		.filter(({ provider, account: linked }) => linked || PROVIDER_ENABLED[provider]());
	const text = (value) => (typeof value === "string" ? value : null);
	const notice = describeConnectResult({ connected: text(params.connected), connect: text(params.connect), error: text(params.error), email: user.email });

	return (
		<LayoutNarrow>
			<HeaderPage title="Account" icon={<AvatarUser name={user.name} email={user.email} image={user.image} size={32} />} />
			<div className="flex flex-col gap-4">
				<FormProfile name={user.name ?? ""} image={user.image ?? ""} maxNameLength={MAX_NAME_LENGTH} />
				<CardSettings title="Email" stagger={1}>
					<RowSettings label="Address" hint={`You sign in with ${[...socialSignins, "a code sent here"].join(", ").replace(/, ([^,]*)$/, " or $1")}.`}>
						<span className="flex h-9 items-center justify-between gap-3 rounded-lg bg-muted/60 px-2.5 text-sm">
							<span className="truncate">{user.email}</span>
							<Lock aria-label="Can't be changed" className="size-3.5 shrink-0 text-muted-foreground" />
						</span>
					</RowSettings>
				</CardSettings>
				{methods.length > 0 && <CardSigninMethods methods={methods} email={user.email} notice={notice} />}
				{isCloud() && <CardRegion />}
				<CardPasskeys />
				{isCloud() && <CardBilling account={account} />}
				<CardExport initial={latestExport ?? null} />
				<CardDelete email={user.email} blockers={blockers} cancelAt={account.cancelAt} />
			</div>
		</LayoutNarrow>
	);
}

function CardRegion() {
	return (
		<CardSettings title="Data location" stagger={1}>
			<RowSettings label="Region" hint="An account lives in one region. To use the other, create an account there.">
				<span className="flex min-h-9 items-center text-sm">Your data is stored in {REGION_PLACES[getRegion()]}.</span>
			</RowSettings>
		</CardSettings>
	);
}

function CardBilling({ account }) {
	const details = getPlanDetails(account);

	return (
		<CardSettings
			title="Billing"
			stagger={2}
			action={
				<Button asChild variant="outline" size="sm">
					<Link href="/billing">{isOnFreeTier(account) ? "Upgrade" : "Manage billing"}</Link>
				</Button>
			}
		>
			<RowSettings label="Plan">
				<span className="flex min-h-9 flex-wrap items-center gap-x-2.5 gap-y-1">
					<span className="text-sm font-medium">{getAccountPlan(account).name}</span>
					<BadgeStatus status={getAccountStatus(account)} />
					{details.length > 0 && <span className="text-sm text-muted-foreground tabular-nums">{details.join(" · ")}</span>}
				</span>
			</RowSettings>
		</CardSettings>
	);
}

function CardDelete({ email, blockers, cancelAt }) {
	return (
		<CardSettings title="Delete account" stagger={4} className="mt-6">
			<p className="px-4 py-3 text-sm text-pretty text-muted-foreground">
				Your account stops at once. {DELETION_GRACE_DAYS} days later, its newsletters, contacts, campaigns and images are deleted
				for good. Signing in before then restores it.
			</p>
			{blockers?.hasPlan && (
				<RowBlocker
					icon={CreditCard}
					title={cancelAt ? `Your plan ends on ${formatDate(cancelAt)}` : "Cancel your plan first"}
					text={
						cancelAt
							? "You can delete your account once it has ended."
							: `Deleting your account doesn't stop ${getBillingProviderName()} from billing it. Cancel it in the billing portal.`
					}
				>
					<form action={openBillingPortal}>
						<Button type="submit" variant="outline" size="sm">
							Billing portal
							<ArrowUpRight data-icon="inline-end" className="opacity-60" />
						</Button>
					</form>
				</RowBlocker>
			)}
			{blockers?.campaigns.length > 0 && (
				<RowBlocker icon={Send} title="Stop your campaigns first" text="Pause the ones sending, and cancel the scheduled ones.">
					<ul className="flex flex-col gap-1">
						{blockers.campaigns.map((campaign) => (
							<li key={String(campaign._id)}>
								<Link
									href={`/campaigns/${campaign._id}`}
									className="-mx-2 flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-sm transition-colors duration-150 hover:bg-muted"
								>
									<span className="truncate">{campaign.subject || "Untitled"}</span>
									<BadgeStatus status={campaign.status} />
								</Link>
							</li>
						))}
					</ul>
				</RowBlocker>
			)}
			<div className="flex justify-end rounded-b-xl bg-destructive/[0.03] px-4 py-3 dark:bg-destructive/[0.06]">
				<DialogDeleteAccount email={email} graceDays={DELETION_GRACE_DAYS} isDisabled={Boolean(blockers)} />
			</div>
		</CardSettings>
	);
}

function RowBlocker({ icon: Icon, title, text, children }) {
	return (
		<div className="flex gap-3 px-4 py-3">
			<span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
				<Icon className="size-4" />
			</span>
			<div className="flex min-w-0 flex-1 flex-col gap-2.5">
				<div className="flex flex-col gap-0.5">
					<p className="text-sm font-medium">{title}</p>
					<p className="text-sm text-pretty text-muted-foreground">{text}</p>
				</div>
				{children}
			</div>
		</div>
	);
}
