import { Suspense } from "react";
import BannerApprovals from "@/components/BannerApprovals";
import BannerBlocked from "@/components/BannerBlocked";
import BannerWatch from "@/components/BannerWatch";
import BarSend from "@/components/BarSend";
import LogoWordmark from "@/components/LogoWordmark";
import MenuUser from "@/components/MenuUser";
import NavLinks from "@/components/NavLinks";
import NavMobile from "@/components/NavMobile";
import NavNewsletter from "@/components/NavNewsletter";
import PaletteCommands from "@/components/PaletteCommands";
import PanelGetStarted from "@/components/PanelGetStarted";
import ShortcutAssistant from "@/components/ShortcutAssistant";
import ProviderPaywall from "@/components/ProviderPaywall";
import { Skeleton } from "@/components/ui/skeleton";
import { SiteAnalytics, SupportChat } from "@/components/SiteExtensions";
import { getSendingStatus, hasActiveSubscription, isBlocked } from "@/lib/account-state";
import { isAudioEnabled } from "@/lib/audio-config";
import { isCloud } from "@/lib/config";
import { isGetStartedOpen } from "@/lib/get-started";
import { PLANS, getAudioLimit } from "@/lib/plans";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";
import { getPricing } from "@/lib/pricing";

export default async function LayoutDashboard({ user, account, isAdmin, children }) {
	// Every account has a plan, Free at least, so the paywall below never opens; it takes the plans as the pricing page has them.
	const hasPlan = hasActiveSubscription(account);
	// The Audio link is for plans that have audio; Free has none, and its pages say so where audio would be.
	const hasAudio = isAudioEnabled() && getAudioLimit(account) !== 0;
	const menu = <MenuUser name={user.name} email={user.email} image={user.image} status={getSendingStatus(account)} hasBilling={isCloud()} isAdmin={isAdmin} />;

	return (
		<ProviderPaywall hasPlan={hasPlan} pricing={getPricing(undefined, PLANS)}>
			<ShortcutAssistant />
			{isBlocked(account) && <BannerBlocked account={account} />}
			<div className="flex min-h-[calc(100dvh-var(--plan-bar-height))] flex-col md:flex-row">
				<aside className="sticky top-(--plan-bar-height) hidden h-[calc(100dvh-var(--plan-bar-height))] w-60 shrink-0 flex-col border-r border-border/60 px-3 py-4 md:flex">
					<LogoWordmark href="/" className="mb-4 h-9 px-2.5" />
					<div className="mb-5">
						<Suspense fallback={<Skeleton className="h-11 rounded-xl" />}>
							<NavNewsletter />
						</Suspense>
					</div>
					<div className="-mx-1 min-h-0 flex-1 overflow-y-auto overscroll-contain px-1">
						<NavLinks hasAudio={hasAudio} />
					</div>
					<div className="shrink-0 border-t border-border/60 pt-3">{menu}</div>
				</aside>
				<NavMobile
					isAdmin={isAdmin}
					hasAudio={hasAudio}
					switcher={
						<Suspense fallback={<Skeleton className="h-8 w-32 rounded-lg" />}>
							<NavNewsletter isCompact />
						</Suspense>
					}
					footer={menu}
				/>
				<main className="min-w-0 flex-1">
					<div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-10 md:py-10">
						<Suspense fallback={null}>
							<BannerApprovals account={account} />
						</Suspense>
						<BannerWatch account={account} />
						{children}
					</div>
				</main>
			</div>
			<Suspense fallback={null}>
				<PaletteForNewsletter hasBilling={isCloud()} hasAudio={hasAudio} isAdmin={isAdmin} />
			</Suspense>
			{isGetStartedOpen(account) && (
				<Suspense fallback={null}>
					<PanelGetStarted account={account} />
				</Suspense>
			)}
			<BarSend />
			{SupportChat && (
				<Suspense fallback={null}>
					<SupportChat user={user} account={account} />
				</Suspense>
			)}
			{SiteAnalytics && <SiteAnalytics user={user} account={account} />}
		</ProviderPaywall>
	);
}

// The palette's "New issue" starts a draft in the open newsletter, which only a server component can read.
async function PaletteForNewsletter({ hasBilling, hasAudio, isAdmin }) {
	const { selected } = await getSelectedNewsletter();
	return <PaletteCommands newsletterId={selected ? String(selected._id) : null} hasBilling={hasBilling} hasAudio={hasAudio} isAdmin={isAdmin} />;
}
