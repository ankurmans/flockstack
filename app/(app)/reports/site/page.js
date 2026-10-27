import { redirect } from "next/navigation";
import ButtonExportReport from "@/components/ButtonExportReport";
import ChartStack from "@/components/ChartStack";
import HeaderPage from "@/components/HeaderPage";
import NavFilters from "@/components/NavFilters";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { runDashboardAction } from "@/lib/actions/dashboard";
import { formatNumber } from "@/lib/format";
import { ADD_NEWSLETTER_PATH } from "@/lib/newsletters";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";

export const metadata = { title: "Website report" };

const RANGES = [[7, "7 days"], [30, "30 days"], [90, "90 days"], [365, "1 year"]];

function Top({ title, rows, name, label }) {
	return (
		<section className="overflow-hidden rounded-xl shadow-border">
			<Table>
				<TableHeader>
					<TableRow className="hover:bg-transparent">
						<TableHead className="pl-4">{title}</TableHead>
						<TableHead className="pr-4 text-right">Views</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.length === 0 ? (
						<TableRow className="hover:bg-transparent">
							<TableCell colSpan={2} className="py-4 pl-4 text-muted-foreground">Nothing yet</TableCell>
						</TableRow>
					) : (
						rows.map((row) => (
							<TableRow key={row[name]} className="tabular-nums">
								<TableCell className="max-w-0 truncate py-3 pl-4">{label(row)}</TableCell>
								<TableCell className="pr-4 text-right">{formatNumber(row.views)}</TableCell>
							</TableRow>
						))
					)}
				</TableBody>
			</Table>
		</section>
	);
}

// The open newsletter's website over the last days: views and visitors, who sent them, from where, and which issues.
export default async function SiteReportPage({ searchParams }) {
	const { selected } = await getSelectedNewsletter();
	if (!selected) redirect(ADD_NEWSLETTER_PATH);
	const query = await searchParams;
	const days = RANGES.some(([value]) => String(value) === String(query.days)) ? Number(query.days) : 30;
	const newsletter = String(selected._id);
	const { output: report } = await runDashboardAction("get_site_report", { newsletter, days });

	return (
		<>
			<HeaderPage title="Website">
				<ButtonExportReport input={{ report: "site", table: "daily", newsletter, days }}>Export days</ButtonExportReport>
				<ButtonExportReport input={{ report: "site", table: "referrers", newsletter, days }}>Export referrers</ButtonExportReport>
			</HeaderPage>
			<div className="flex flex-col gap-4">
				<NavFilters label="Range" name="days" current={days} options={RANGES} base="/reports/site" query={{ days: String(days) }} />
				{report && (
					<>
						<dl className="grid grid-cols-2 gap-3 animate-enter">
							{[
								["Page views", formatNumber(report.totals.views)],
								["Daily visitors", formatNumber(report.totals.visitors)],
							].map(([label, value]) => (
								<div key={label} className="rounded-xl bg-card p-4 shadow-border">
									<dt className="text-xs text-muted-foreground">{label}</dt>
									<dd className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{value}</dd>
								</div>
							))}
						</dl>
						<section className="rounded-xl bg-card p-4 shadow-border animate-enter">
							<h2 className="mb-4 text-sm font-medium">Page views each day</h2>
							<ChartStack
								ariaLabel={`Page views for each of the last ${report.days} days: ${report.totals.views} in all`}
								columns={report.daily.map((day) => ({ label: day.date, values: [day.views] }))}
								series={[{ label: "Page views" }]}
							/>
						</section>
						<div className="grid gap-4 md:grid-cols-2 animate-enter">
							<Top title="Where visitors came from" rows={report.referrers} name="referrer" label={(row) => row.referrer} />
							<Top title="Countries" rows={report.countries} name="code" label={(row) => row.country} />
							<Top title="Devices" rows={report.devices.filter((row) => row.views > 0).map((row) => ({ ...row, label: row.device[0].toUpperCase() + row.device.slice(1) }))} name="device" label={(row) => row.label} />
							<div className="md:col-span-2">
								<Top title="Issues read most" rows={report.pages} name="slug" label={(row) => row.title} />
							</div>
						</div>
						<p className="text-xs text-pretty text-muted-foreground">
							Counted by FlockStack as pages open, with no cookie, no script from another company and nothing kept about a visitor. A visitor is a hash of their network address and browser that changes every day and is never stored, so visitors are counted for each day: someone back tomorrow counts again. Browsers that send Do Not Track or Global Privacy Control, and crawlers, aren&apos;t counted. Days are UTC.
						</p>
					</>
				)}
			</div>
		</>
	);
}
