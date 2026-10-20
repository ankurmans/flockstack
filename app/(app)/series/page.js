import Link from "next/link";
import { Plus, Repeat } from "lucide-react";
import BadgeStatus from "@/components/BadgeStatus";
import HeaderPage from "@/components/HeaderPage";
import StateEmpty from "@/components/StateEmpty";
import TimeLocal from "@/components/TimeLocal";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { runAction } from "@/lib/actions/run-action";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";

export const metadata = { title: "Series" };

const WHEN = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };

// The open newsletter's recurring series: when each runs next, and what its last run did, through list_series as the API reads it.
export default async function SeriesPage() {
	const { account, user, selected } = await getSelectedNewsletter();
	const { series } = selected
		? await runAction("list_series", { account, user, via: "dashboard", input: { newsletter: String(selected._id) } })
		: { series: [] };

	return (
		<>
			<HeaderPage title="Series">
				{selected && (
					<Button asChild>
						<Link href="/series/new">
							<Plus data-icon="inline-start" />
							New
						</Link>
					</Button>
				)}
			</HeaderPage>

			{series.length === 0 ? (
				<StateEmpty icon={Repeat} title="No series yet">
					<p className="max-w-sm text-sm text-pretty text-muted-foreground">
						A series turns a blog or podcast feed into an issue on a schedule: every Monday, say, with what was published since the last one.
						Each issue waits as a draft for you to review, or goes out by itself.
					</p>
				</StateEmpty>
			) : (
				<div className="overflow-hidden rounded-xl shadow-border animate-enter">
					<Table>
						<TableHeader>
							<TableRow className="hover:bg-transparent">
								<TableHead className="pl-4">Name</TableHead>
								<TableHead>Status</TableHead>
								<TableHead className="hidden sm:table-cell">Next run</TableHead>
								<TableHead className="hidden pr-4 md:table-cell">Last run</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{series.map((one) => (
								<TableRow key={one.id}>
									<TableCell className="max-w-0 py-3 pl-4 font-medium">
										<Link href={`/series/${one.id}`} className="block truncate hover:underline">
											{one.name}
										</Link>
										<span className="block truncate text-xs font-normal text-muted-foreground">
											{one.scheduleSummary}, {one.mode === "send" ? "sent automatically" : "draft for review"}
										</span>
									</TableCell>
									<TableCell>
										<BadgeStatus status={one.active ? "active" : "paused"} />
									</TableCell>
									<TableCell className="hidden text-muted-foreground tabular-nums sm:table-cell">
										{one.nextRunAt ? <TimeLocal value={one.nextRunAt} options={WHEN} /> : "Off"}
									</TableCell>
									<TableCell className="hidden pr-4 md:table-cell">{one.lastRun ? <BadgeStatus status={one.lastRun.status} /> : <span className="text-muted-foreground">None yet</span>}</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			)}
		</>
	);
}
