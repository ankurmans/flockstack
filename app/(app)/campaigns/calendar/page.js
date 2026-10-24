import { Suspense } from "react";
import { cookies } from "next/headers";
import Link from "next/link";
import { CalendarDays, ChevronLeft, ChevronRight, List } from "lucide-react";
import ButtonNewCampaign from "@/components/ButtonNewCampaign";
import ButtonPlanDraft from "@/components/ButtonPlanDraft";
import ChipCalendar from "@/components/ChipCalendar";
import CookieTimezone from "@/components/CookieTimezone";
import FormMoveItem from "@/components/FormMoveItem";
import FormNewBatch from "@/components/FormNewBatch";
import FormQuickItem from "@/components/FormQuickItem";
import HeaderPage from "@/components/HeaderPage";
import { Button } from "@/components/ui/button";
import { scoped } from "@/lib/account-scope";
import { getMonthGrid, isMonthKey, shiftMonthKey } from "@/lib/calendar";
import { getContentPlan, listUnplannedDrafts } from "@/lib/content-plan";
import { CHANNEL_LABELS, CONTENT_CHANNELS, CONTENT_STATES, FUNNEL_STAGES, STATE_LABELS } from "@/lib/content-rules";
import { VIEWS, VIEW_LABELS, getCalendarHref, getWeekStart, groupByDay, hasFilters, monthOf, readDate, readFilters, readView } from "@/lib/content-view";
import { formatNumber } from "@/lib/format";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";
import { TIME_ZONE_COOKIE, formatDateKey, resolveTimeZone, shiftDateKey, toDateKey } from "@/lib/time-zone";
import { cn } from "@/lib/utils";
import EditorialBatch from "@/models/EditorialBatch";

export const metadata = { title: "Calendar" };

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const SELECT_CLASS = "h-9 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25";

function ListDay({ entries, viewerTimeZone, withMove = false }) {
	return (
		<ul className="flex flex-col gap-1.5">
			{entries.map((entry) => (
				<li key={`${entry.kind}-${entry.itemId ?? entry.campaignId}`} className="flex flex-col gap-1">
					<ChipCalendar entry={entry} viewerTimeZone={viewerTimeZone} isRoomy />
					{withMove && entry.kind === "planned" && entry.itemId && (
						<FormMoveItem id={entry.itemId} title={entry.title} date={entry.date} time={entry.time ?? ""} timeZone={entry.timeZone ?? undefined} isFolded />
					)}
				</li>
			))}
		</ul>
	);
}

// The open newsletter's plan and deliveries by day (lib/content-plan.js), in the browser's timezone: planned items outlined, issues
// that really go out or went out filled, the backlog beside them, in a month, a week or an agenda.
export default async function CalendarPage({ searchParams }) {
	const [view, params, cookieStore] = await Promise.all([getSelectedNewsletter(), searchParams, cookies()]);
	const { account, selected } = view;
	const timeZone = resolveTimeZone(cookieStore.get(TIME_ZONE_COOKIE)?.value);
	const today = toDateKey(new Date(), timeZone);
	const mode = readView(params.view);
	const filters = readFilters(params);
	const month = isMonthKey(params.month) ? params.month : monthOf(readDate(params.date, today));
	const anchor = readDate(params.date, month === today.slice(0, 7) ? today : `${month}-01`);
	const weekStart = getWeekStart(anchor);
	const grid = getMonthGrid(month);
	const range = mode === "week" ? { from: weekStart, to: shiftDateKey(weekStart, 6) } : mode === "agenda" ? { from: grid.first, to: grid.lastDay } : { from: grid.start, to: grid.end };
	const [plan, batches, drafts] = selected
		? await Promise.all([
				getContentPlan(account, {
					...range,
					timeZone,
					filters: { newsletterId: selected._id, channel: filters.channel, funnelStage: filters.funnelStage, pillar: filters.pillar, batchId: filters.batch, state: filters.state },
					includeBacklog: true,
				}),
				EditorialBatch.find(scoped(account, { newsletterId: selected._id, status: "active" })).sort({ createdAt: -1 }).limit(100).select({ name: 1 }).lean(),
				listUnplannedDrafts(account, selected._id),
			])
		: [null, [], []];
	const dates = [];
	for (let date = grid.start; date <= grid.end; date = shiftDateKey(date, 1)) dates.push(date);
	const weekDates = Array.from({ length: 7 }, (_, index) => shiftDateKey(weekStart, index));
	const monthTitle = formatDateKey(`${month}-01`, { month: "long", year: "numeric" });
	const title = mode === "week" ? `${formatDateKey(weekStart)} to ${formatDateKey(weekDates[6], { month: "short", day: "numeric", year: "numeric" })}` : monthTitle;
	const days = plan ? groupByDay(plan.entries) : new Map();
	const monthEntries = plan ? plan.entries.filter(({ date }) => date.startsWith(month)) : [];
	const issueCount = monthEntries.filter(({ kind }) => kind !== "planned").length;
	const plannedCount = monthEntries.filter(({ kind }) => kind === "planned").length;
	const agenda = [...(mode === "week" ? weekDates.map((date) => [date, days.get(date) ?? []]) : [...days.entries()].filter(([date]) => date.startsWith(month)))].toSorted(([a], [b]) => (a < b ? -1 : 1));
	const link = (changes) => getCalendarHref({ view: mode, month, filters, ...changes });
	const step = mode === "week" ? { previous: link({ month: undefined, date: shiftDateKey(weekStart, -7) }), next: link({ month: undefined, date: shiftDateKey(weekStart, 7) }), unit: "week" } : { previous: link({ month: shiftMonthKey(month, -1) }), next: link({ month: shiftMonthKey(month, 1) }), unit: "month" };

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

			<div className="mb-4 flex flex-wrap items-center justify-between gap-3">
				<h2 className="text-lg font-semibold tracking-tight">{title}</h2>
				<div className="flex flex-wrap items-center gap-2">
					<nav className="flex gap-1" aria-label="Calendar view">
						{VIEWS.map((name) => (
							<Button key={name} asChild variant={name === mode ? "secondary" : "ghost"} size="sm">
								<Link href={getCalendarHref({ view: name, month, date: name === "week" ? anchor : undefined, filters })} aria-current={name === mode ? "page" : undefined}>
									{VIEW_LABELS[name]}
								</Link>
							</Button>
						))}
					</nav>
					<div className="flex items-center gap-1">
						<Button asChild variant="ghost" size="icon-sm">
							<Link href={step.previous} aria-label={`Previous ${step.unit}`}>
								<ChevronLeft />
							</Link>
						</Button>
						<Button asChild variant="ghost" size="sm">
							<Link href={getCalendarHref({ view: mode, filters })}>Today</Link>
						</Button>
						<Button asChild variant="ghost" size="icon-sm">
							<Link href={step.next} aria-label={`Next ${step.unit}`}>
								<ChevronRight />
							</Link>
						</Button>
					</div>
				</div>
			</div>

			<details className="mb-4" open={hasFilters(filters) || undefined}>
				<summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">Filters{hasFilters(filters) && `, ${Object.values(filters).filter(Boolean).length} on`}</summary>
				<form method="get" action="/campaigns/calendar" className="mt-3 flex flex-wrap items-end gap-2" aria-label="Filter the calendar">
					{mode !== "month" && <input type="hidden" name="view" value={mode} />}
					{mode === "week" ? <input type="hidden" name="date" value={anchor} /> : <input type="hidden" name="month" value={month} />}
					<label className="flex flex-col gap-1 text-xs text-muted-foreground">
						Channel
						<select name="channel" defaultValue={filters.channel} className={SELECT_CLASS}>
							<option value="">All</option>
							{CONTENT_CHANNELS.map((channel) => (
								<option key={channel} value={channel}>
									{CHANNEL_LABELS[channel]}
								</option>
							))}
						</select>
					</label>
					<label className="flex flex-col gap-1 text-xs text-muted-foreground">
						Funnel stage
						<select name="stage" defaultValue={filters.funnelStage} className={SELECT_CLASS}>
							<option value="">All</option>
							{FUNNEL_STAGES.map((stage) => (
								<option key={stage} value={stage}>
									{stage}
								</option>
							))}
						</select>
					</label>
					<label className="flex flex-col gap-1 text-xs text-muted-foreground">
						Pillar
						<input name="pillar" defaultValue={filters.pillar} maxLength={60} className={cn(SELECT_CLASS, "w-36")} />
					</label>
					<label className="flex flex-col gap-1 text-xs text-muted-foreground">
						Batch
						<select name="batch" defaultValue={filters.batch} className={SELECT_CLASS}>
							<option value="">All</option>
							{batches.map((batch) => (
								<option key={batch._id} value={String(batch._id)}>
									{batch.name}
								</option>
							))}
						</select>
					</label>
					<label className="flex flex-col gap-1 text-xs text-muted-foreground">
						State
						<select name="state" defaultValue={filters.state} className={SELECT_CLASS}>
							<option value="">All</option>
							{CONTENT_STATES.map((state) => (
								<option key={state} value={state}>
									{STATE_LABELS[state]}
								</option>
							))}
						</select>
					</label>
					<Button type="submit" variant="outline">
						Filter
					</Button>
					{hasFilters(filters) && (
						<Button asChild variant="ghost">
							<Link href={getCalendarHref({ view: mode, month: mode === "week" ? undefined : month, date: mode === "week" ? anchor : undefined })}>Clear</Link>
						</Button>
					)}
				</form>
			</details>

			<p className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
				<span>
					<span className="mr-1 inline-block rounded border border-dashed border-foreground/40 px-1 text-foreground">Planned</span>
					an intention: nothing is sent or published on that day
				</span>
				<span>
					<span className="mr-1 inline-block rounded bg-amber-500/15 px-1 text-amber-900 dark:text-amber-200">Scheduled</span>
					<span className="mr-1 inline-block rounded bg-muted px-1 text-foreground">Sent</span>
					a campaign at the time it goes out or went out
				</span>
			</p>

			<div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
				<div>
					{mode === "month" && (
						<>
							<div className="hidden overflow-hidden rounded-xl shadow-border md:block animate-enter">
								<div className="grid grid-cols-7 border-b border-border/60 bg-muted/40 text-xs text-muted-foreground">
									{WEEKDAYS.map((day) => (
										<div key={day} className="px-2 py-1.5 font-medium">
											{day}
										</div>
									))}
								</div>
								<ol className="grid grid-cols-7" aria-label={`${monthTitle}, by day`}>
									{dates.map((date) => {
										const entries = days.get(date) ?? [];
										const isInMonth = date.startsWith(month);
										return (
											<li key={date} className={cn("min-h-28 border-r border-b border-border/60 p-1.5 [&:nth-child(7n)]:border-r-0", !isInMonth && "bg-muted/30")}>
												<span className={cn("mb-1 grid size-6 place-items-center rounded-full text-xs tabular-nums", date === today ? "bg-foreground font-medium text-background" : isInMonth ? "text-foreground" : "text-muted-foreground")}>
													{Number(date.slice(8))}
												</span>
												<ul className="flex flex-col gap-1">
													{entries.map((entry) => (
														<li key={`${entry.kind}-${entry.itemId ?? entry.campaignId}`}>
															<ChipCalendar entry={entry} viewerTimeZone={timeZone} />
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
									<p className="rounded-xl px-4 py-10 text-center text-sm text-muted-foreground shadow-border">Nothing scheduled or sent in {monthTitle}.</p>
								) : (
									<ol className="flex flex-col gap-3">
										{agenda.map(([date, entries]) => (
											<li key={date} className="rounded-xl p-3 shadow-border">
												<p className="mb-2 text-xs font-medium text-muted-foreground">{formatDateKey(date, { weekday: "long", month: "short", day: "numeric" })}</p>
												<ListDay entries={entries} viewerTimeZone={timeZone} withMove />
											</li>
										))}
									</ol>
								)}
							</div>
						</>
					)}
					{mode !== "month" && (
						<ol className={cn("flex flex-col gap-3 animate-enter", mode === "week" && "md:grid md:grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] md:gap-2")} aria-label={`${title}, by day`}>
							{(mode === "week" ? agenda : agenda.filter(([, entries]) => entries.length > 0)).map(([date, entries]) => (
								<li key={date} className="rounded-xl p-3 shadow-border">
									<p className={cn("mb-2 text-xs font-medium", date === today ? "text-foreground" : "text-muted-foreground")}>{formatDateKey(date, { weekday: "short", month: "short", day: "numeric" })}</p>
									{entries.length === 0 ? <p className="text-xs text-muted-foreground">Nothing planned.</p> : <ListDay entries={entries} viewerTimeZone={timeZone} withMove />}
								</li>
							))}
							{mode === "agenda" && agenda.every(([, entries]) => entries.length === 0) && (
								<li className="rounded-xl px-4 py-10 text-center text-sm text-muted-foreground shadow-border">Nothing scheduled, sent or planned in {monthTitle}.</li>
							)}
						</ol>
					)}
					{plan && (
						<p className="mt-3 text-xs text-muted-foreground tabular-nums">
							{formatNumber(issueCount)} {issueCount === 1 ? "issue" : "issues"} this month. {formatNumber(plannedCount)} planned. Times are in your timezone, {timeZone}.
						</p>
					)}
				</div>

				<aside aria-label="Backlog" className="flex flex-col gap-4 self-start">
					<section className="rounded-xl bg-card shadow-border">
						<h2 className="flex h-12 items-center justify-between px-4 text-sm font-medium">
							Backlog
							<span className="text-xs font-normal text-muted-foreground tabular-nums">{plan?.backlog.length ?? 0} without a day</span>
						</h2>
						<div className="border-t border-border/60">
							{selected && <FormQuickItem newsletterId={String(selected._id)} />}
							{plan?.backlog.length === 0 && <p className="border-t border-border/60 px-4 py-3 text-sm text-muted-foreground">Nothing without a day.</p>}
							<ul className="divide-y divide-border/60 border-t border-border/60">
								{plan?.backlog.map((item) => (
									<li key={item.id} className="flex flex-col gap-2 px-4 py-3">
										<Link href={`/campaigns/calendar/items/${item.id}`} className="text-sm font-medium hover:underline">
											{item.title || "Untitled"}
										</Link>
										<p className="text-xs text-muted-foreground">
											{CHANNEL_LABELS[item.channel]}
											{item.funnelStage && ` · ${item.funnelStage}`} · {STATE_LABELS[item.state]}
											{item.review.editedAfterApproval && " · Edited after approval"}
											{item.campaign && ` · Issue is a ${item.campaign.status}`}
										</p>
										<FormMoveItem id={item.id} title={item.title} />
									</li>
								))}
							</ul>
						</div>
					</section>
					{selected && drafts.length > 0 && (
						<section className="rounded-xl bg-card shadow-border">
							<h2 className="flex h-12 items-center px-4 text-sm font-medium">Drafts not in the plan</h2>
							<ul className="divide-y divide-border/60 border-t border-border/60">
								{drafts.map((draft) => (
									<li key={draft._id} className="flex items-center justify-between gap-2 px-4 py-2.5">
										<Link href={`/campaigns/${draft._id}`} className="min-w-0 truncate text-sm hover:underline">
											{draft.subject || "Untitled"}
										</Link>
										<ButtonPlanDraft newsletterId={String(selected._id)} campaignId={String(draft._id)} subject={draft.subject} />
									</li>
								))}
							</ul>
						</section>
					)}
					{selected && (
						<section className="rounded-xl bg-card shadow-border">
							<h2 className="flex h-12 items-center px-4 text-sm font-medium">Batches</h2>
							<ul className="divide-y divide-border/60 border-t border-border/60">
								{batches.map((batch) => (
									<li key={batch._id}>
										<Link href={`/campaigns/calendar/batches/${batch._id}`} className="block px-4 py-2.5 text-sm hover:bg-muted/50">
											{batch.name}
										</Link>
									</li>
								))}
							</ul>
							<div className="border-t border-border/60">
								<FormNewBatch newsletterId={String(selected._id)} />
							</div>
						</section>
					)}
				</aside>
			</div>
		</>
	);
}
