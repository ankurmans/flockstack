import Link from "next/link";
import { Newspaper, Plus } from "lucide-react";
import BadgeStatus from "@/components/BadgeStatus";
import HeaderPage from "@/components/HeaderPage";
import StateEmpty from "@/components/StateEmpty";
import TimeLocal from "@/components/TimeLocal";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { runAction } from "@/lib/actions/run-action";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";

export const metadata = { title: "Briefings" };

const WHEN = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };

// The open newsletter's briefings: when each runs next, and what its last run did, through list_briefings as the API reads it.
export default async function BriefingsPage() {
	const { account, user, selected } = await getSelectedNewsletter();
	const { briefings } = selected
		? await runAction("list_briefings", { account, user, via: "dashboard", input: { newsletter: String(selected._id) } })
		: { briefings: [] };

	return (
		<>
			<HeaderPage title="Briefings">
				<Button asChild variant="outline">
					<Link href="/ai-keys">AI keys</Link>
				</Button>
				{selected && briefings.length === 0 && (
					<Button asChild>
						<Link href="/briefings/new">
							<Plus data-icon="inline-start" />
							New
						</Link>
					</Button>
				)}
			</HeaderPage>

			{briefings.length === 0 ? (
				<StateEmpty icon={Newspaper} title="No briefing yet">
					<p className="max-w-sm text-sm text-pretty text-muted-foreground">
						A briefing reads the sources you choose on a schedule, picks the stories your readers care about and writes a short issue with every
						story linked to its source. Each issue waits as a draft for you to review. It runs on your own AI key.
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
							{briefings.map((briefing) => (
								<TableRow key={briefing.id}>
									<TableCell className="max-w-0 py-3 pl-4 font-medium">
										<Link href={`/briefings/${briefing.id}`} className="block truncate hover:underline">
											{briefing.name}
										</Link>
										<span className="block truncate text-xs font-normal text-muted-foreground">
											{briefing.scheduleSummary}, {briefing.sources.length === 1 ? "1 source" : `${briefing.sources.length} sources`}
										</span>
									</TableCell>
									<TableCell>
										<BadgeStatus status={briefing.status} />
									</TableCell>
									<TableCell className="hidden text-muted-foreground tabular-nums sm:table-cell">
										{briefing.nextRunAt ? <TimeLocal value={briefing.nextRunAt} options={WHEN} /> : "Off"}
									</TableCell>
									<TableCell className="hidden pr-4 md:table-cell">
										{briefing.lastRun ? <BadgeStatus status={briefing.lastRun.status} /> : <span className="text-muted-foreground">None yet</span>}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			)}
		</>
	);
}
