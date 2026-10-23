import Link from "next/link";
import { Activity, ArrowUpRight } from "lucide-react";
import BadgeStatus from "@/components/BadgeStatus";
import HeaderPage from "@/components/HeaderPage";
import StateEmpty from "@/components/StateEmpty";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { scoped } from "@/lib/account-scope";
import { PRESET_INFO } from "@/lib/action-scopes";
import { afterCursor, encodeCursor } from "@/lib/actions/cursor";
import { ACTIVITY_PAGE_SIZE, getDayCounts, listActivity, listDayCounts } from "@/lib/agent-activity";
import { ACTIVITY_RETENTION_DAYS } from "@/lib/agent-activity-rules";
import { getKeyLevel, listApiKeys } from "@/lib/api-keys";
import { requireAccount } from "@/lib/auth";
import { connectDb } from "@/lib/db";
import { formatDate, formatRelative } from "@/lib/format";
import { listConnectedApps } from "@/lib/oauth-apps";
import { isObjectIdString } from "@/lib/validation";
import { ACTIVITY_STATUSES } from "@/models/AgentActivity";
import Newsletter from "@/models/Newsletter";

export const metadata = { title: "Agent activity" };

const DAY_CHOICES = [1, 7, 30, ACTIVITY_RETENTION_DAYS];

function pick(value) {
	return typeof value === "string" && value ? value : undefined;
}

// What API keys and connected apps did that changed something or touched contact data, and what happened to their approvals.
// ?actor= is the per-key view.
export default async function AgentActivityPage({ searchParams }) {
	const params = await searchParams;
	const { account } = await requireAccount();
	await connectDb();
	const actor = pick(params.actor);
	const action = pick(params.action)?.slice(0, 100);
	const newsletter = isObjectIdString(pick(params.newsletter) ?? "") ? pick(params.newsletter) : undefined;
	const status = ACTIVITY_STATUSES.includes(params.status) ? params.status : undefined;
	const days = DAY_CHOICES.includes(Number(params.days)) ? Number(params.days) : ACTIVITY_RETENTION_DAYS;
	const cursor = pick(params.cursor);

	const [keys, apps, newsletters] = await Promise.all([
		listApiKeys(account),
		listConnectedApps(account),
		Newsletter.find(scoped(account)).sort({ createdAt: 1, _id: 1 }).select({ name: 1 }).lean(),
	]);
	const actors = [
		...keys.map((key) => ({ id: String(key._id), name: key.name, kind: "API key", level: getKeyLevel(key), key })),
		...apps.map((app) => ({ id: app.id, name: app.name, kind: "App", level: app.level })),
	];
	const selected = actor ? actors.find(({ id }) => id === actor) : null;
	const names = new Map(newsletters.map(({ _id, name }) => [String(_id), name]));
	const { entries, hasMore } = await listActivity(account, {
		actorId: actor,
		action,
		newsletterId: newsletter,
		status,
		days,
		after: cursor ? safeAfter(cursor) : undefined,
	});
	const [daily, today] = await Promise.all([listDayCounts(account, { actorId: actor }), actor ? getDayCounts(account, [actor]) : new Map()]);
	const last = entries.at(-1);

	return (
		<>
			<HeaderPage title={selected ? `Activity of ${selected.name}` : "Agent activity"} backHref={selected ? "/agent-activity" : undefined}>
				<Button asChild variant="outline">
					<Link href="/approvals">Approvals</Link>
				</Button>
				<Button asChild variant="outline">
					<Link href="/docs/agent-safety">
						Docs
						<ArrowUpRight data-icon="inline-end" className="opacity-60" />
					</Link>
				</Button>
			</HeaderPage>

			<div className="flex flex-col gap-6">
				<form method="get" className="flex flex-wrap items-end gap-3 text-xs text-muted-foreground">
					<Select name="actor" label="Key or app" value={actor} options={actors.map(({ id, name, kind }) => [id, `${name} (${kind})`])} any="All" />
					<label className="flex flex-col gap-1">
						Action
						<input name="action" defaultValue={action ?? ""} placeholder="send_campaign" maxLength={100} className="h-9 w-44 rounded-lg bg-background px-2 text-sm text-foreground shadow-border" />
					</label>
					<Select name="newsletter" label="Newsletter" value={newsletter} options={newsletters.map(({ _id, name }) => [String(_id), name])} any="All" />
					<Select name="status" label="Result" value={status} options={ACTIVITY_STATUSES.map((value) => [value, value.replaceAll("_", " ")])} any="Any" />
					<Select name="days" label="Period" value={String(days)} options={DAY_CHOICES.map((value) => [String(value), value === 1 ? "Today" : `${value} days`])} />
					<Button type="submit" variant="outline">
						Filter
					</Button>
				</form>

				{selected && (
					<section className="rounded-xl bg-card p-4 shadow-border sm:p-5">
						<p className="text-sm">
							<span className="font-medium">{PRESET_INFO[selected.level]?.label ?? selected.level}</span> {selected.kind.toLowerCase()} · {today.get(selected.id)?.calls ?? 0} calls today
							{selected.key?.dailyCap ? ` of ${selected.key.dailyCap}` : ""}
							{selected.key?.revokedAt ? " · revoked" : ""}
						</p>
						<p className="mt-1 text-xs text-muted-foreground">{PRESET_INFO[selected.level]?.can}</p>
					</section>
				)}

				{daily.length > 0 && (
					<section className="flex flex-col gap-2">
						<h2 className="text-sm font-medium text-muted-foreground">Calls per day</h2>
						<ul className="flex flex-wrap gap-2 text-xs">
							{daily.map((row) => (
								<li key={row.day} className="rounded-lg px-2.5 py-1.5 shadow-border tabular-nums">
									<span className="text-muted-foreground">{formatDate(row.day)}</span> {row.calls} calls, {row.changes} changes{row.denied ? `, ${row.denied} denied` : ""}
								</li>
							))}
						</ul>
					</section>
				)}

				{entries.length === 0 ? (
					<StateEmpty icon={Activity} title="No agent activity">
						<p className="max-w-sm text-sm text-pretty text-muted-foreground">
							Calls from API keys and connected apps that change something or show contact data are listed here for {ACTIVITY_RETENTION_DAYS} days.
						</p>
					</StateEmpty>
				) : (
					<div className="overflow-hidden rounded-xl shadow-border animate-enter">
						<Table>
							<TableHeader>
								<TableRow className="hover:bg-transparent">
									<TableHead className="pl-4">When</TableHead>
									<TableHead>Who</TableHead>
									<TableHead>What</TableHead>
									<TableHead className="hidden md:table-cell">Newsletter</TableHead>
									<TableHead className="pr-4">Result</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{entries.map((entry) => (
									<TableRow key={String(entry._id)}>
										<TableCell className="py-2.5 pl-4 whitespace-nowrap text-muted-foreground">{formatRelative(entry.createdAt)}</TableCell>
										<TableCell className="max-w-40 truncate">
											<Link href={`/agent-activity?actor=${entry.actorId}`} className="hover:underline">
												{entry.actorName}
											</Link>
										</TableCell>
										<TableCell className="max-w-96 whitespace-normal">
											<span className="block font-mono text-xs">{entry.action}</span>
											<span className="block text-xs text-pretty text-muted-foreground">{entry.summary}</span>
										</TableCell>
										<TableCell className="hidden text-muted-foreground md:table-cell">{entry.newsletterId ? (names.get(String(entry.newsletterId)) ?? "") : ""}</TableCell>
										<TableCell className="pr-4">
											<BadgeStatus status={entry.status} />
											{entry.errorCode && <span className="mt-0.5 block font-mono text-xs text-muted-foreground">{entry.errorCode}</span>}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>
				)}
				{hasMore && last && (
					<p className="text-center text-sm">
						<Link href={getNextHref(params, encodeCursor(last.createdAt, last._id))} className="text-link underline decoration-link/30 underline-offset-4 hover:decoration-link">
							Older entries
						</Link>
					</p>
				)}
				<p className="text-xs text-muted-foreground">
					{ACTIVITY_PAGE_SIZE} entries a page. The log keeps ids, names and counts, never what an email says or who it went to, and is deleted after {ACTIVITY_RETENTION_DAYS} days.
				</p>
			</div>
		</>
	);
}

function safeAfter(cursor) {
	try {
		return afterCursor(cursor, "createdAt");
	} catch {
		return undefined;
	}
}

function getNextHref(params, cursor) {
	const next = new URLSearchParams();
	for (const key of ["actor", "action", "newsletter", "status", "days"]) if (typeof params[key] === "string" && params[key]) next.set(key, params[key]);
	next.set("cursor", cursor);
	return `/agent-activity?${next}`;
}

function Select({ name, label, value, options, any }) {
	return (
		<label className="flex flex-col gap-1">
			{label}
			<select name={name} defaultValue={value ?? ""} className="h-9 rounded-lg bg-background px-2 text-sm text-foreground shadow-border">
				{any && <option value="">{any}</option>}
				{options.map(([optionValue, text]) => (
					<option key={optionValue} value={optionValue}>
						{text}
					</option>
				))}
			</select>
		</label>
	);
}
