import Link from "next/link";
import { notFound } from "next/navigation";
import BadgeStatus from "@/components/BadgeStatus";
import CardSettings from "@/components/CardSettings";
import FormSeries from "@/components/FormSeries";
import HeaderPage from "@/components/HeaderPage";
import TimeLocal from "@/components/TimeLocal";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { runAction } from "@/lib/actions/run-action";
import { isValidObjectId } from "@/lib/docdb";
import { getSelectedNewsletter, openNewsletter } from "@/lib/selected-newsletter";

export const metadata = { title: "Series" };

const WHEN = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };

// A series' settings and its run history, through get_series' siblings list_series and list_series_runs as the API reads them.
export default async function SeriesDetailPage({ params }) {
	const [{ id }, view] = await Promise.all([params, getSelectedNewsletter()]);
	const { account, user } = view;
	if (!isValidObjectId(id)) notFound();
	const { series: all } = await runAction("list_series", { account, user, input: {}, via: "dashboard" });
	const series = all.find((one) => one.id === id);
	if (!series) notFound();
	openNewsletter(view, series.newsletterId, `/series/${id}`);
	const { runs } = await runAction("list_series_runs", { account, user, input: { id }, via: "dashboard" });

	return (
		<>
			<HeaderPage title={series.name} backHref="/series" meta={<BadgeStatus status={series.active ? "active" : "paused"} />} />
			<div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
				<FormSeries newsletterId={series.newsletterId} series={series} defaultTimeZone={series.schedule.timeZone} />
				<CardSettings title="Runs" className="self-start">
					{runs.length === 0 ? (
						<p className="px-4 py-3 text-sm text-muted-foreground">Nothing has run yet.</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow className="hover:bg-transparent">
									<TableHead className="pl-4">When</TableHead>
									<TableHead>Result</TableHead>
									<TableHead className="pr-4 text-right">Items</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{runs.map((run) => (
									<TableRow key={run.id}>
										<TableCell className="py-3 pl-4 text-muted-foreground tabular-nums">
											<TimeLocal value={run.dueAt} options={WHEN} />
											{run.isManual && <span className="block text-xs">Run by hand</span>}
										</TableCell>
										<TableCell className="max-w-0">
											<BadgeStatus status={run.status} />
											{run.reason && <span className="mt-1 block truncate text-xs text-muted-foreground" title={run.reason}>{run.reason}</span>}
											{run.campaignId && (
												<Link href={`/campaigns/${run.campaignId}`} className="mt-1 block text-xs text-link hover:underline">
													Open the issue
												</Link>
											)}
										</TableCell>
										<TableCell className="pr-4 text-right tabular-nums">{run.itemCount}</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
				</CardSettings>
			</div>
		</>
	);
}
