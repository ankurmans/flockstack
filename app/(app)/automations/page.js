import Link from "next/link";
import { Workflow } from "lucide-react";
import BadgeStatus from "@/components/BadgeStatus";
import ButtonNewAutomation from "@/components/ButtonNewAutomation";
import HeaderPage from "@/components/HeaderPage";
import StateEmpty from "@/components/StateEmpty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { runAction } from "@/lib/actions/run-action";
import { formatNumber } from "@/lib/format";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";

export const metadata = { title: "Automations" };

// The open newsletter's automations: what starts each, and how many contacts are in it, finished it or left it.
export default async function AutomationsPage() {
	const { account, user, selected } = await getSelectedNewsletter();
	const { automations } = selected
		? await runAction("list_automations", { account, user, via: "dashboard", input: { newsletter: String(selected._id) } })
		: { automations: [] };

	return (
		<>
			<HeaderPage title="Automations">
				<ButtonNewAutomation newsletterId={selected ? String(selected._id) : null} />
			</HeaderPage>

			{automations.length === 0 ? (
				<StateEmpty icon={Workflow} title="No automations yet">
					<p className="max-w-sm text-sm text-pretty text-muted-foreground">
						An automation sends a series of emails on its own: a welcome series when someone subscribes, a follow-up when they get a
						tag, a note before a renewal date.
					</p>
				</StateEmpty>
			) : (
				<div className="overflow-hidden rounded-xl shadow-border animate-enter">
					<Table>
						<TableHeader>
							<TableRow className="hover:bg-transparent">
								<TableHead className="pl-4">Name</TableHead>
								<TableHead>Status</TableHead>
								<TableHead className="hidden text-right sm:table-cell">In it</TableHead>
								<TableHead className="hidden text-right sm:table-cell">Finished</TableHead>
								<TableHead className="hidden pr-4 text-right md:table-cell">Left</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{automations.map((automation) => (
								<TableRow key={automation.id} className="tabular-nums">
									<TableCell className="max-w-0 py-3 pl-4 font-medium">
										<Link href={`/automations/${automation.id}`} className="block truncate hover:underline">
											{automation.name}
										</Link>
										<span className="block truncate text-xs font-normal text-muted-foreground">{automation.summary}</span>
									</TableCell>
									<TableCell>
										<BadgeStatus status={automation.status} />
									</TableCell>
									<TableCell className="hidden text-right sm:table-cell">{formatNumber(automation.enrollments.active)}</TableCell>
									<TableCell className="hidden text-right sm:table-cell">{formatNumber(automation.enrollments.completed)}</TableCell>
									<TableCell className="hidden pr-4 text-right md:table-cell">{formatNumber(automation.enrollments.exited)}</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			)}
		</>
	);
}
