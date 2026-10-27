import { redirect } from "next/navigation";
import ButtonExportReport from "@/components/ButtonExportReport";
import FormRevenueRefresh from "@/components/FormRevenueRefresh";
import HeaderPage from "@/components/HeaderPage";
import NavFilters from "@/components/NavFilters";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { runDashboardAction } from "@/lib/actions/dashboard";
import { formatNumber } from "@/lib/format";
import { ADD_NEWSLETTER_PATH } from "@/lib/newsletters";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";

export const metadata = { title: "Subscription revenue" };
const RANGES = [[30, "30 days"], [90, "90 days"], [365, "1 year"], [730, "2 years"]];
const CHANGE_LABELS = { first_seen: "First observed", activated: "Became recurring", reactivated: "Reactivated", upgraded: "Tier upgrades", downgraded: "Tier downgrades", expanded: "MRR expansions", contracted: "MRR contractions", churn: "Canceled or unpaid", paused: "Collection pauses", currency_changed: "Currency changes", plan_changed: "Other plan changes", updated: "Other updates" };
function money(value, currency) {
	if (value == null || !currency) return "—";
	const formatter = new Intl.NumberFormat("en-GB", { style: "currency", currency: currency.toUpperCase() });
	return formatter.format(value / 10 ** formatter.resolvedOptions().maximumFractionDigits);
}
const percent = (value) => value == null ? "—" : new Intl.NumberFormat("en-GB", { style: "percent", maximumFractionDigits: 2 }).format(value);

export default async function SubscriptionRevenuePage({ searchParams }) {
	const { selected } = await getSelectedNewsletter();
	if (!selected) redirect(ADD_NEWSLETTER_PATH);
	const query = await searchParams;
	const days = RANGES.some(([value]) => value === Number(query.days)) ? Number(query.days) : 30;
	const newsletter = String(selected._id);
	const { output: report, failure } = await runDashboardAction("get_subscription_revenue_report", { newsletter, days });
	return <><HeaderPage title="Subscription revenue" /><div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
		<div className="flex flex-wrap items-center justify-between gap-3"><NavFilters label="Range" name="days" current={days} options={RANGES} base="/reports/revenue" query={{ days: String(days) }} /><ButtonExportReport input={{ report: "revenue", newsletter, days }} /></div>
		{failure && <p role="alert" className="text-sm text-destructive">{failure.message}</p>}
		<FormRevenueRefresh key={newsletter} newsletter={newsletter} />
		{report && <>
			<p className="text-xs text-muted-foreground">{report.basis}</p>
			<p className="text-xs text-muted-foreground">{report.coverage.observedSubscriptions} stored subscription snapshots; {report.coverage.observedInvoices} invoice snapshots in this window. {report.coverage.untrackedSubscriptions == null ? "The scan cannot establish how many known subscriptions are missing." : `${report.coverage.untrackedSubscriptions} known contact subscriptions have no financial snapshot.`} Unknown amounts appear as a dash.</p>
			{report.coverage.limited && <p role="status" className="rounded-xl border p-4 text-sm">This bounded scan is incomplete. Full monetary totals and the cohort rate are unavailable; known subtotals and event counts describe the scanned records. Use the private account export for all stored records.</p>}
			{report.coverage.latestSubscriptionObservationAt && <p className="text-xs text-muted-foreground">Subscription snapshots range from {report.coverage.oldestSubscriptionObservationAt} to {report.coverage.latestSubscriptionObservationAt}. Refresh to read newer provider state. These dates do not establish complete event history.</p>}
			{report.currencies.length === 0 && <p className="rounded-xl border p-5 text-sm text-muted-foreground">No financial observations yet. Refresh known subscriptions to begin. Earlier invoices and changes are not backfilled.</p>}
			{report.currencies.map((row) => <section key={row.currency || "unknown"} className="overflow-hidden rounded-xl border bg-card">
				<h2 className="border-b px-4 py-3 text-sm font-medium">{row.currency?.toUpperCase() || "Unknown currency"}</h2>
				<dl className="grid gap-4 p-4 sm:grid-cols-3">
					<div><dt className="text-xs text-muted-foreground">Paid invoice snapshots</dt><dd className="text-xl font-semibold tabular-nums">{money(row.paidInvoiceMinor, row.currency)}</dd><p className="text-xs text-muted-foreground">{row.invoiceCount} observed invoices; includes credits and out-of-band payments.</p></div>
					<div><dt className="text-xs text-muted-foreground">Calculated MRR, latest snapshots</dt><dd className="text-xl font-semibold tabular-nums">{money(row.monthlyRecurringMinor, row.currency)}</dd><p className="text-xs text-muted-foreground">Known subtotal: {money(row.knownMonthlyRecurringMinor, row.currency)}. {row.unknownMrr} unsupported or unknown snapshots.</p></div>
					<div><dt className="text-xs text-muted-foreground">Monthly price value, before adjustments</dt><dd className="text-xl font-semibold tabular-nums">{money(row.grossMonthlyPriceMinor, row.currency)}</dd><p className="text-xs text-muted-foreground">Known subtotal: {money(row.knownGrossMonthlyPriceMinor, row.currency)}. This is not net MRR.</p></div>
				</dl>
				<p className="border-t px-4 py-3 text-xs text-muted-foreground">{row.recurringSubscriptions} tracked recurring subscriptions; {row.cancelAtPeriodEnd} marked to end; {row.collectionPaused} with collection paused. {row.markedPaidOutsideStripe} invoices marked paid outside Stripe; {row.unknownPaymentMethod} have no recorded out-of-band flag. Paid invoice totals excluding tax: {money(row.invoiceTotalExTaxMinor, row.currency)}. Post-payment credit notes: {money(row.postPaymentCreditsMinor, row.currency)}.</p>
			</section>)}
			<section className="rounded-xl border bg-card p-4"><h2 className="mb-3 text-sm font-medium">Observed subscription changes</h2><dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">{Object.entries(report.observedChanges).map(([key, count]) => <div key={key}><dt className="text-xs text-muted-foreground">{CHANGE_LABELS[key]}</dt><dd className="text-lg font-semibold tabular-nums">{formatNumber(count)}</dd></div>)}</dl><p className="mt-4 text-xs text-muted-foreground">First observed does not mean a new paid reader. Tier direction requires the same recorded tier order; reordering tiers does not establish an upgrade. Churn counts observed transitions to canceled or unpaid, not collection pauses or a future cancellation request.</p></section>
			<section className="rounded-xl border bg-card p-4"><h2 className="text-sm font-medium">Tracked starting cohort</h2><p className="mt-2 text-sm">{report.trackedCohort.startingSubscriptions} previously observed subscriptions with a positive recurring price at the start; {report.trackedCohort.endedCanceledOrUnpaid} ended canceled or unpaid. Cohort loss: {percent(report.trackedCohort.lossRate)}.</p><p className="mt-2 text-xs text-muted-foreground">{report.trackedCohort.unknownBaseline} unknown baselines. This follows the tracked cohort to its latest observed end state; it is not a whole-business churn rate. Unknown or incomplete scans leave the rate blank.</p></section>
			{report.unknownReasons.length > 0 && <p className="text-xs text-muted-foreground">MRR gaps: {report.unknownReasons.map((item) => `${item.reason.replaceAll("_", " ")} (${item.count})`).join(", ")}.</p>}
			{report.monthlyInvoices.length > 0 && <section><h2 className="mb-3 text-sm font-medium">Observed invoice snapshots by month, UTC</h2><Table><TableHeader><TableRow><TableHead>Month</TableHead><TableHead>Currency</TableHead><TableHead>Invoices</TableHead><TableHead className="text-right">Paid invoice amount</TableHead></TableRow></TableHeader><TableBody>{report.monthlyInvoices.map((row) => <TableRow key={`${row.month}:${row.currency}`}><TableCell>{row.month}</TableCell><TableCell>{row.currency.toUpperCase()}</TableCell><TableCell>{row.invoiceCount}</TableCell><TableCell className="text-right tabular-nums">{money(row.paidInvoiceMinor, row.currency)}</TableCell></TableRow>)}</TableBody></Table></section>}
		</>}
	</div></>;
}
