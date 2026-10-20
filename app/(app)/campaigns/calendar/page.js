import { Suspense } from "react";
import { cookies } from "next/headers";
import Link from "next/link";
import { CalendarDays, ChevronLeft, ChevronRight, List } from "lucide-react";
import ButtonNewCampaign from "@/components/ButtonNewCampaign";
import CookieTimezone from "@/components/CookieTimezone";
import HeaderPage from "@/components/HeaderPage";
import { Button } from "@/components/ui/button";
import { getCalendar, getMonthGrid, isMonthKey, shiftMonthKey } from "@/lib/calendar";
import { formatNumber } from "@/lib/format";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";
import { TIME_ZONE_COOKIE, formatDateKey, resolveTimeZone, shiftDateKey, toDateKey } from "@/lib/time-zone";
import { cn } from "@/lib/utils";

export const metadata = { title: "Calendar" };

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const TIME = { hour: "numeric", minute: "2-digit" };

// What a scheduled or sent issue looks like in a day's cell.
const STATUS_STYLES = {
	scheduled: "bg-amber-500/15 text-amber-900 dark:text-amber-200",
	sending: "bg-sky-500/15 text-sky-900 dark:text-sky-200",
	paused: "bg-orange-500/15 text-orange-900 dark:text-orange-200",
	sent: "bg-muted text-foreground",
};

// The open newsletter's scheduled and sent issues by day (lib/calendar.js), in the browser's timezone.
export default async function CalendarPage({ searchParams }) {
	const [view, params, cookieStore] = await Promise.all([getSelectedNewsletter(), searchParams, cookies()]);
	const { account, selected } = view;
	const timeZone = resolveTimeZone(cookieStore.get(TIME_ZONE_COOKIE)?.value);
	const today = toDateKey(new Date(), timeZone);
	const month = isMonthKey(params.month) ? params.month : today.slice(0, 7);
	const calendar = selected ? await getCalendar(account, { month, timeZone, newsletterId: selected._id }) : null;
	const { start, end } = getMonthGrid(month);
	const dates = [];
	for (let date = start; date <= end; date = shiftDateKey(date, 1)) dates.push(date);
	const title = formatDateKey(`${month}-01`, { month: "long", year: "numeric" });
	const formatTime = (at) => at.toLocaleTimeString("en-US", { ...TIME, timeZone });
	const agenda = calendar ? [...calendar.days.entries()].toSorted(([a], [b]) => (a < b ? -1 : 1)) : [];

	return (
		<>
			<Suspense fallback={null}>
				<CookieTimezone />
			</Suspense>
			<HeaderPage title="Campaigns">
				<div className="flex gap-1" role="group" aria-label="View">
					<Button asChild variant="ghost" size="sm">
						<Link href="/campaigns">
							<List data-icon="inline-start" />
							List
						</Link>
					</Button>
					<Button asChild variant="secondary" size="sm">
						<Link href="/campaigns/calendar" aria-current="page">
							<CalendarDays data-icon="inline-start" />
							Calendar
						</Link>
					</Button>
				</div>
				<ButtonNewCampaign newsletterId={selected ? String(selected._id) : null} />
			</HeaderPage>

			<div className="mb-4 flex items-center justify-between gap-3">
				<h2 className="text-lg font-semibold tracking-tight">{title}</h2>
				<div className="flex items-center gap-1">
					<Button asChild variant="ghost" size="icon-sm">
						<Link href={`/campaigns/calendar?month=${shiftMonthKey(month, -1)}`} aria-label="Previous month">
							<ChevronLeft />
						</Link>
					</Button>
					<Button asChild variant="ghost" size="sm">
						<Link href="/campaigns/calendar">Today</Link>
					</Button>
					<Button asChild variant="ghost" size="icon-sm">
						<Link href={`/campaigns/calendar?month=${shiftMonthKey(month, 1)}`} aria-label="Next month">
							<ChevronRight />
						</Link>
					</Button>
				</div>
			</div>

			<div className="hidden overflow-hidden rounded-xl shadow-border md:block animate-enter">
				<div className="grid grid-cols-7 border-b border-border/60 bg-muted/40 text-xs text-muted-foreground">
					{WEEKDAYS.map((day) => (
						<div key={day} className="px-2 py-1.5 font-medium">
							{day}
						</div>
					))}
				</div>
				<ol className="grid grid-cols-7" aria-label={`${title}, by day`}>
					{dates.map((date) => {
						const issues = calendar?.days.get(date) ?? [];
						const isInMonth = date.startsWith(month);
						return (
							<li key={date} className={cn("min-h-28 border-r border-b border-border/60 p-1.5 [&:nth-child(7n)]:border-r-0", !isInMonth && "bg-muted/30")}>
								<span className={cn("mb-1 grid size-6 place-items-center rounded-full text-xs tabular-nums", date === today ? "bg-foreground font-medium text-background" : isInMonth ? "text-foreground" : "text-muted-foreground")}>
									{Number(date.slice(8))}
								</span>
								<ul className="flex flex-col gap-1">
									{issues.map((issue) => (
										<li key={issue.id}>
											<Link href={`/campaigns/${issue.id}`} className={cn("block truncate rounded px-1.5 py-0.5 text-xs", STATUS_STYLES[issue.status])} title={`${issue.subject || "Untitled"} · ${issue.status}`}>
												<span className="tabular-nums opacity-70">{formatTime(issue.at)}</span> {issue.subject || "Untitled"}
											</Link>
										</li>
									))}
								</ul>
							</li>
						);
					})}
				</ol>
			</div>

			<div className="md:hidden">
				{agenda.length === 0 ? (
					<p className="rounded-xl px-4 py-10 text-center text-sm text-muted-foreground shadow-border">Nothing scheduled or sent in {title}.</p>
				) : (
					<ol className="flex flex-col gap-3">
						{agenda.map(([date, issues]) => (
							<li key={date} className="rounded-xl p-3 shadow-border">
								<p className="mb-2 text-xs font-medium text-muted-foreground">{formatDateKey(date, { weekday: "long", month: "short", day: "numeric" })}</p>
								<ul className="flex flex-col gap-1">
									{issues.map((issue) => (
										<li key={issue.id}>
											<Link href={`/campaigns/${issue.id}`} className={cn("block truncate rounded px-2 py-1.5 text-sm", STATUS_STYLES[issue.status])}>
												<span className="tabular-nums opacity-70">{formatTime(issue.at)}</span> {issue.subject || "Untitled"}
											</Link>
										</li>
									))}
								</ul>
							</li>
						))}
					</ol>
				)}
			</div>

			{calendar && (
				<p className="mt-3 text-xs text-muted-foreground tabular-nums">
					{formatNumber(calendar.entries.length)} {calendar.entries.length === 1 ? "issue" : "issues"} this month. Times are in your timezone, {timeZone}.
				</p>
			)}
		</>
	);
}
