import { redirect } from "next/navigation";
import ButtonExportReport from "@/components/ButtonExportReport";
import ChartStack from "@/components/ChartStack";
import HeaderPage from "@/components/HeaderPage";
import NavFilters from "@/components/NavFilters";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { runDashboardAction } from "@/lib/actions/dashboard";
import { formatNumber } from "@/lib/format";
import { ADD_NEWSLETTER_PATH } from "@/lib/newsletters";
import { BREAKDOWNS, DEFAULT_REPORT_DAYS, GRANULARITIES, MAX_REPORT_DAYS } from "@/lib/report-rules";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";

export const metadata = { title: "Growth report" };

const RANGES = [[30, "30 days"], [90, "90 days"], [180, "6 months"], [365, "1 year"], [MAX_REPORT_DAYS, "2 years"]];
const BREAKDOWN_LABELS = { source: "Source", channel: "Channel", campaign: "UTM campaign", form: "Form", none: "Total" };
const percent = (value) => (value === null ? "-" : `${(value * 100).toFixed(0)}%`);
const signed = (value) => `${value > 0 ? "+" : ""}${formatNumber(value)}`;

function pick(value, allowed, fallback) {
	const text = Array.isArray(value) ? value[0] : value;
	return allowed.includes(text) ? text : fallback;
}

// The open newsletter's growth: who joined and left in each day, week or month of a range of up to two years, and where the
// joins came from. Every table is in the CSV export.
export default async function GrowthReportPage({ searchParams }) {
	const { selected } = await getSelectedNewsletter();
	if (!selected) redirect(ADD_NEWSLETTER_PATH);
	const query = await searchParams;
	const days = Number(pick(query.days, RANGES.map(([value]) => String(value)), String(DEFAULT_REPORT_DAYS)));
	const granularity = pick(query.granularity, GRANULARITIES, "");
	const by = pick(query.by, BREAKDOWNS, "source");
	const newsletter = String(selected._id);
	const { output: report } = await runDashboardAction("get_growth_report", { newsletter, days, by, ...(granularity && { granularity }) });
	const current = { days, by, ...(granularity && { granularity }) };

	return (
		<>
			<HeaderPage title="Growth">
				<ButtonExportReport input={{ report: "growth", table: "series", newsletter, ...current }}>Export periods</ButtonExportReport>
				{report?.groups.length > 0 && <ButtonExportReport input={{ report: "growth", table: "breakdown", newsletter, ...current }}>Export {BREAKDOWN_LABELS[by].toLowerCase()}s</ButtonExportReport>}
			</HeaderPage>
			<div className="flex flex-col gap-4">
				<div className="flex flex-col gap-2 animate-enter">
					<NavFilters label="Range" name="days" current={days} options={RANGES} base="/reports" query={Object.fromEntries(Object.entries(current).map(([key, value]) => [key, String(value)]))} />
					<NavFilters label="Group by" name="by" current={by} options={BREAKDOWNS.map((value) => [value, BREAKDOWN_LABELS[value]])} base="/reports" query={Object.fromEntries(Object.entries(current).map(([key, value]) => [key, String(value)]))} />
					<NavFilters label="Period" name="granularity" current={report?.granularity ?? ""} options={GRANULARITIES.map((value) => [value, value[0].toUpperCase() + value.slice(1)])} base="/reports" query={Object.fromEntries(Object.entries(current).map(([key, value]) => [key, String(value)]))} />
				</div>

				{report && (
					<>
						<dl className="grid grid-cols-2 gap-3 sm:grid-cols-4 animate-enter">
							{[
								["New subscribers", formatNumber(report.totals.new)],
								["Left", formatNumber(report.totals.left)],
								["Net", signed(report.totals.net)],
								["Subscribers now", formatNumber(report.totals.active), report.totals.pending > 0 ? `${formatNumber(report.totals.pending)} waiting to confirm` : null],
							].map(([label, value, note]) => (
								<div key={label} className="rounded-xl bg-card p-4 shadow-border">
									<dt className="text-xs text-muted-foreground">{label}</dt>
									<dd className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{value}</dd>
									{note && <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>}
								</div>
							))}
						</dl>

						<section className="rounded-xl bg-card p-4 shadow-border animate-enter">
							<h2 className="mb-4 text-sm font-medium">
								New subscribers{by !== "none" && ` by ${BREAKDOWN_LABELS[by].toLowerCase()}`}, {report.from} to {report.to}
							</h2>
							<ChartStack
								ariaLabel={`New subscribers in each ${report.granularity} from ${report.from} to ${report.to}: ${report.totals.new} in all`}
								columns={report.buckets.map((bucket, index) => ({
									label: bucket.label,
									values: report.groups.length > 0 ? report.groups.map((group) => group.series[index]) : [bucket.new],
								}))}
								series={report.groups.length > 0 ? report.groups : [{ label: "New subscribers" }]}
							/>
						</section>

						{report.groups.length > 0 && (
							<div className="overflow-hidden rounded-xl shadow-border animate-enter">
								<Table>
									<TableHeader>
										<TableRow className="hover:bg-transparent">
											<TableHead className="pl-4">{BREAKDOWN_LABELS[by]}</TableHead>
											<TableHead className="text-right">New</TableHead>
											<TableHead className="text-right">Still subscribed</TableHead>
											<TableHead className="pr-4 text-right">Kept</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{report.groups.map((group) => (
											<TableRow key={group.key} className="tabular-nums">
												<TableCell className="max-w-0 truncate py-3 pl-4 font-medium">{group.label}</TableCell>
												<TableCell className="text-right">{formatNumber(group.new)}</TableCell>
												<TableCell className="text-right">{formatNumber(group.active)}</TableCell>
												<TableCell className="pr-4 text-right">{percent(group.retention)}</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							</div>
						)}

						<div className="overflow-hidden rounded-xl shadow-border animate-enter">
							<Table>
								<TableHeader>
									<TableRow className="hover:bg-transparent">
										<TableHead className="pl-4">Period</TableHead>
										<TableHead className="text-right">New</TableHead>
										<TableHead className="text-right">Left</TableHead>
										<TableHead className="text-right">Net</TableHead>
										<TableHead className="pr-4 text-right">Total</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{[...report.buckets].reverse().map((bucket) => (
										<TableRow key={bucket.key} className="tabular-nums">
											<TableCell className="py-3 pl-4 font-medium">{bucket.label}</TableCell>
											<TableCell className="text-right">{formatNumber(bucket.new)}</TableCell>
											<TableCell className="text-right">{formatNumber(bucket.left)}</TableCell>
											<TableCell className="text-right">{signed(bucket.net)}</TableCell>
											<TableCell className="pr-4 text-right">{formatNumber(bucket.total)}</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</div>
						<p className="text-xs text-pretty text-muted-foreground">
							Days are UTC. New counts signups that have confirmed (or needed no confirmation) on the day they signed up; left counts unsubscribes, bounces and complaints on the day they happened, imports aside. The total is worked back from today&apos;s subscribers. Signups from before FlockStack kept where they came from have the channel their source says and no campaign.
						</p>
					</>
				)}
			</div>
		</>
	);
}
