import { redirect } from "next/navigation";
import { FileText } from "lucide-react";
import ButtonExportReport from "@/components/ButtonExportReport";
import HeaderPage from "@/components/HeaderPage";
import NavFilters from "@/components/NavFilters";
import StateEmpty from "@/components/StateEmpty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { runDashboardAction } from "@/lib/actions/dashboard";
import { formatDate, formatNumber } from "@/lib/format";
import { ADD_NEWSLETTER_PATH } from "@/lib/newsletters";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";

export const metadata = { title: "Issues report" };

const COUNTS = [[5, "5"], [10, "10"], [25, "25"]];
const percent = (value) => (value === null ? "-" : `${(value * 100).toFixed(1)}%`);

// A number with a bar as long as it is next to the biggest of the column, so issues compare at a glance.
function Metric({ value, share, display }) {
	return (
		<div className="flex flex-col items-end gap-1">
			<span>{display ?? formatNumber(value)}</span>
			<span aria-hidden="true" className="h-1 w-16 rounded-full bg-muted">
				<span className="block h-full rounded-full bg-foreground/60" style={{ width: `${Math.round(share * 100)}%` }} />
			</span>
		</div>
	);
}

// The open newsletter's newest sent issues side by side: opens, clicks and unsubscribes with their rates.
export default async function IssuesReportPage({ searchParams }) {
	const { selected } = await getSelectedNewsletter();
	if (!selected) redirect(ADD_NEWSLETTER_PATH);
	const query = await searchParams;
	const limit = COUNTS.some(([value]) => String(value) === String(query.limit)) ? Number(query.limit) : 10;
	const newsletter = String(selected._id);
	const { output } = await runDashboardAction("compare_issues", { newsletter, limit });
	const issues = output?.issues ?? [];
	const most = (key) => Math.max(0.0001, ...issues.map((issue) => issue[key] ?? 0));

	return (
		<>
			<HeaderPage title="Issues">
				{issues.length > 0 && <ButtonExportReport input={{ report: "issues", newsletter, limit }} />}
			</HeaderPage>
			<div className="flex flex-col gap-4">
				<NavFilters label="Newest" name="limit" current={limit} options={COUNTS} base="/reports/issues" query={{ limit: String(limit) }} />
				{issues.length === 0 ? (
					<StateEmpty icon={FileText} title="No sent issues yet">
						<p className="max-w-sm text-sm text-pretty text-muted-foreground">Once an issue goes out, its opens, clicks and unsubscribes show here next to the others.</p>
					</StateEmpty>
				) : (
					<div className="overflow-x-auto rounded-xl shadow-border animate-enter">
						<Table>
							<TableHeader>
								<TableRow className="hover:bg-transparent">
									<TableHead className="pl-4">Issue</TableHead>
									<TableHead className="text-right">Sent</TableHead>
									<TableHead className="text-right">Opened</TableHead>
									<TableHead className="text-right">Clicked</TableHead>
									<TableHead className="text-right">Unsubscribed</TableHead>
									<TableHead className="pr-4 text-right">Web views</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{issues.map((issue) => (
									<TableRow key={issue.id} className="align-top tabular-nums">
										<TableCell className="min-w-48 max-w-72 py-3 pl-4">
											<span className="block truncate font-medium">{issue.subject || "(no subject)"}</span>
											<span className="block text-xs text-muted-foreground">{issue.sentAt ? formatDate(issue.sentAt) : ""}</span>
											{issue.topLink && <span className="block truncate text-xs text-muted-foreground">Top link: {issue.topLink.url}</span>}
										</TableCell>
										<TableCell className="py-3 text-right">{formatNumber(issue.sent)}</TableCell>
										<TableCell className="py-3"><Metric value={issue.opened} display={`${percent(issue.openRate)}`} share={(issue.openRate ?? 0) / most("openRate")} /></TableCell>
										<TableCell className="py-3"><Metric value={issue.clicked} display={`${percent(issue.clickRate)}`} share={(issue.clickRate ?? 0) / most("clickRate")} /></TableCell>
										<TableCell className="py-3"><Metric value={issue.unsubscribed} display={`${formatNumber(issue.unsubscribed)} (${percent(issue.unsubscribeRate)})`} share={(issue.unsubscribeRate ?? 0) / most("unsubscribeRate")} /></TableCell>
										<TableCell className="py-3 pr-4 text-right">{formatNumber(issue.webViews)}</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>
				)}
				<p className="text-xs text-pretty text-muted-foreground">Rates are of delivered emails. Opens count Apple Mail&apos;s privacy loads, so look at clicks too. The CSV has every count and the most clicked link.</p>
			</div>
		</>
	);
}
