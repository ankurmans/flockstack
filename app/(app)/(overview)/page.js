import { Suspense } from "react";
import { cookies } from "next/headers";
import Link from "next/link";
import { ChevronRight, Newspaper, Plus } from "lucide-react";
import BannerUsage from "@/components/BannerUsage";
import CardUsage from "@/components/CardUsage";
import CardWarmup from "@/components/CardWarmup";
import ChartSends from "@/components/ChartSends";
import ChartSubscribers from "@/components/ChartSubscribers";
import CookieTimezone from "@/components/CookieTimezone";
import HeaderPage from "@/components/HeaderPage";
import ListStats from "@/components/ListStats";
import SkeletonCampaigns from "@/components/SkeletonCampaigns";
import { SkeletonSends, SkeletonStats, SkeletonSubscribers } from "@/components/SkeletonOverview";
import StateEmpty from "@/components/StateEmpty";
import SwatchChart from "@/components/SwatchChart";
import TableCampaigns from "@/components/TableCampaigns";
import { Button } from "@/components/ui/button";
import { hasActiveSubscription } from "@/lib/account-state";
import { requireAccount } from "@/lib/auth";
import { getSendVolumes, listNewsletterCampaigns } from "@/lib/campaign-queries";
import { formatNumber, formatSigned } from "@/lib/format";
import { ADD_NEWSLETTER_PATH } from "@/lib/newsletters";
import { getEmailStats, getHourlySends, getSubscriberHistory } from "@/lib/overview-data";
import { PERIOD_DAYS, overviewDays } from "@/lib/overview-series";
import { getLapsedPlan } from "@/lib/free-plan";
import { getAccountPlan } from "@/lib/plans";
import { getSelectedNewsletter, openNewsletter } from "@/lib/selected-newsletter";
import { getPace, getWarmup } from "@/lib/send-spread";
import { TIME_ZONE_COOKIE, resolveTimeZone, timeZoneLabel } from "@/lib/time-zone";
import { getUsage, hasWelcomeEmailsOn } from "@/lib/usage";
import { cn } from "@/lib/utils";

// The open newsletter's numbers, then the plan its account's newsletters share. The page waits for the
// newsletter; every section then loads on its own behind a skeleton of its size.
export default async function OverviewPage({ searchParams }) {
	const { account } = await requireAccount();
	// The usage needs the account only, so it is asked while the newsletters are; and every section's data needs the account and the
	// open newsletter only, so all of it is asked as soon as the newsletters are known, not after the usage has come back: the sections
	// used to start their reads when React reached them, one round trip behind (tests/query-budget.test.mjs counts the depth).
	const usagePromise = getUsage(account);
	const [view, { newsletter: newsletterParam, days: daysParam }, cookieStore] = await Promise.all([getSelectedNewsletter(), searchParams, cookies()]);
	openNewsletter(view, newsletterParam, "/");
	const { newsletters, selected } = view;
	const days = overviewDays(daysParam);
	const timeZone = resolveTimeZone(cookieStore.get(TIME_ZONE_COOKIE)?.value);
	const selectedId = selected?._id.toString();
	const accountId = account._id;
	const data = selected && {
		stats: started(getEmailStats({ accountId, newsletterId: selected._id, days })),
		history: started(getSubscriberHistory({ accountId, newsletterId: selected._id, timeZone, days })),
		hours: started(getHourlySends({ accountId, newsletterId: selected._id, timeZone })),
		campaigns: started(listNewsletterCampaigns(account, selected._id, 5)),
	};
	const usage = await usagePromise;
	const hasPlan = hasActiveSubscription(account);
	const pace = hasPlan && getWarmup(account) ? getPace(account, await getSendVolumes(account)) : null;
	const isWelcomePaused = usage.welcomeEmailsPaused && (await hasWelcomeEmailsOn(accountId));

	return (
		<>
			<Suspense fallback={null}>
				<CookieTimezone />
			</Suspense>
			{hasPlan && <BannerUsage usage={usage} isWelcomePaused={isWelcomePaused} lapsedPlan={getLapsedPlan(account)} />}
			<HeaderPage title="Overview" />
			<form action="/" className="mb-6 flex flex-wrap items-center gap-2"><label htmlFor="overview-days" className="text-sm text-muted-foreground">Report range</label><select id="overview-days" name="days" defaultValue={days} className="rounded-md border bg-background p-2 text-sm">{[30, 90, 180, 365, 730].map((value) => <option key={value} value={value}>{value} days</option>)}</select><button className="rounded-md border px-3 py-2 text-sm">Apply range</button><p className="w-full text-xs text-muted-foreground">Compared with the same period before. Usage is this billing month. Imported subscriber history may be incomplete.</p></form>

			<div className="flex flex-col gap-8">
				{pace && (
					<section style={{ "--stagger": 1 }} className="animate-enter">
						<CardWarmup pace={pace} />
					</section>
				)}
				{selected ? (
					<>
						<Section title={`Last ${days} days`} stagger={1}>
							<div className="overflow-hidden rounded-2xl bg-card shadow-border">
								<Suspense key={`stats-${selectedId}`} fallback={<SkeletonStats />}>
									<StatsEmail promise={data.stats} />
								</Suspense>
								<div className="border-t border-border/60">
									<Suspense key={`subscribers-${selectedId}`} fallback={<SkeletonSubscribers />}>
										<CardSubscribers promise={data.history} days={days} />
									</Suspense>
								</div>
							</div>
						</Section>

						<Section title="Today" stagger={2}>
							<Suspense key={`sends-${selectedId}`} fallback={<SkeletonSends />}>
								<CardSends promise={data.hours} timeZone={timeZone} />
							</Suspense>
						</Section>

						<Section title="Campaigns" href="/campaigns" stagger={3}>
							<Suspense key={`campaigns-${selectedId}`} fallback={<SkeletonCampaigns rows={5} />}>
								<TableRecentCampaigns promise={data.campaigns} newsletter={selected} />
							</Suspense>
						</Section>
					</>
				) : (
					<StateEmpty icon={Newspaper} title="No newsletters yet">
						<Button asChild variant="outline" size="sm">
							<Link href={ADD_NEWSLETTER_PATH}>
								<Plus data-icon="inline-start" />
								Add a newsletter
							</Link>
						</Button>
					</StateEmpty>
				)}

				{hasPlan && usage.emailsLimit !== null && (
					<Section title={`${getAccountPlan(account)?.name ?? "Your"} plan`} href="/billing" stagger={4}>
						<CardUsage usage={usage} isShared={newsletters.length > 1} />
					</Section>
				)}
			</div>
		</>
	);
}

// A read that has begun: if the page redirects or fails before its section awaits it, a rejection is not an unhandled one.
function started(promise) {
	promise.catch(() => {});
	return promise;
}

async function StatsEmail({ promise }) {
	const stats = await promise;
	return (
		<div className="animate-fade-in">
			<ListStats current={stats.current} previous={stats.previous} />
		</div>
	);
}

async function CardSubscribers({ promise, days = PERIOD_DAYS }) {
	const history = await promise;

	return (
		<div className="flex flex-col gap-6 p-5 animate-fade-in sm:p-6">
			<div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
				<div className="flex flex-col gap-1">
					<h2 className="text-sm font-medium text-muted-foreground">Subscribers</h2>
					<p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
						<span className="text-4xl font-semibold tracking-tight tabular-nums">
							{formatNumber(history.total)}
						</span>
						<span className={cn("text-sm font-medium tabular-nums", growthTone(history.growth))}>
							{formatSigned(history.growth)} in {days} days
						</span>
					</p>
				</div>
				<ListLegend
					items={[
						{ swatch: "line", label: `Last ${days} days`, value: formatSigned(history.growth) },
						{ swatch: "dashed", label: `Previous ${days} days`, value: formatSigned(history.previousGrowth) },
					]}
				/>
			</div>
			<ChartSubscribers current={history.current} previous={history.previous} />
		</div>
	);
}

async function CardSends({ promise, timeZone }) {
	const hours = await promise;
	const sentToday = hours.reduce((sum, { today }) => sum + (today ?? 0), 0);
	const sentYesterday = hours.reduce((sum, { yesterday }) => sum + yesterday, 0);

	return (
		<div className="flex flex-col gap-6 rounded-2xl bg-card p-5 shadow-border animate-fade-in sm:p-6">
			<div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
				<div className="flex flex-col gap-1">
					<h2 className="text-sm font-medium text-muted-foreground">Emails sent per hour</h2>
					<p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
						<span className="text-3xl font-semibold tracking-tight tabular-nums">{formatNumber(sentToday)}</span>
						<span className="text-sm text-muted-foreground tabular-nums">
							{formatNumber(sentYesterday)} yesterday
						</span>
					</p>
				</div>
				<ListLegend
					items={[
						{ swatch: "bar", label: "Today" },
						{ swatch: "ghost", label: "Yesterday" },
						{ label: timeZoneLabel(timeZone) },
					]}
				/>
			</div>
			<ChartSends hours={hours} />
		</div>
	);
}

async function TableRecentCampaigns({ promise, newsletter }) {
	const campaigns = await promise;
	if (campaigns.length === 0) {
		return (
			<p className="rounded-xl px-4 py-6 text-center text-sm text-muted-foreground shadow-border animate-fade-in">
				No campaigns yet
			</p>
		);
	}

	return (
		<div className="animate-fade-in">
			<TableCampaigns campaigns={campaigns} newsletter={newsletter} />
		</div>
	);
}

function Section({ title, href, stagger, children }) {
	return (
		<section style={{ "--stagger": stagger }} className="flex flex-col gap-3 animate-enter">
			<SectionTitle href={href}>{title}</SectionTitle>
			{children}
		</section>
	);
}

function SectionTitle({ href, children }) {
	if (!href) return <h2 className="text-sm font-medium text-muted-foreground">{children}</h2>;
	return (
		<h2 className="text-sm font-medium text-muted-foreground">
			<Link href={href} className="group inline-flex items-center gap-1 transition-colors hover:text-foreground">
				{children}
				<ChevronRight className="size-3.5 transition-transform duration-150 group-hover:translate-x-0.5" />
			</Link>
		</h2>
	);
}

function ListLegend({ items }) {
	return (
		<ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
			{items.map(({ swatch, label, value }) => (
				<li key={label} className="flex items-center gap-2">
					{swatch && <SwatchChart kind={swatch} />}
					{label}
					{value && <span className="font-medium text-foreground tabular-nums">{value}</span>}
				</li>
			))}
		</ul>
	);
}

function growthTone(value) {
	if (value > 0) return "text-emerald-600 dark:text-emerald-400";
	if (value < 0) return "text-red-600 dark:text-red-400";
	return "text-muted-foreground";
}
