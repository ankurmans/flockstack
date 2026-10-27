import "server-only";
import { scoped } from "@/lib/account-scope";
import { classifySubscriptionChange, REVENUE_SCAN_LIMITS } from "@/lib/subscription-revenue-rules";
import SubscriptionFinancial from "@/models/SubscriptionFinancial";
import SubscriptionChange from "@/models/SubscriptionChange";
import SubscriptionInvoice from "@/models/SubscriptionInvoice";
import GroupSubscription from "@/models/GroupSubscription";
import Contact from "@/models/Contact";

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const CHANGE_KINDS = ["first_seen", "activated", "reactivated", "upgraded", "downgraded", "expanded", "contracted", "churn", "paused", "currency_changed", "plan_changed", "updated"];
export const REVENUE_BASIS = "Latest observed Stripe subscriptions and paid invoice snapshots. Each currency is separate. Invoice payments can include customer credit or payments marked paid outside Stripe; they are not cash, net revenue or payouts. Refunds, disputes and processing fees are not deducted. Earlier history is not backfilled. MRR is a calculated monthly normalization of observed fixed prices for active and past_due subscriptions, excluding trials, metered prices and paused collection, and subtracting known recurring discounts. It is not a payable invoice or a guaranteed payment. One-time discounts and fees do not change MRR. Unsupported discounts or tax adjustments leave MRR unknown. Counts and cohort rates describe tracked observations, not complete business history.";

export async function getSubscriptionRevenueReport({ account, newsletter, days = 30, now = new Date() }) {
	const from = new Date(+now - days * 86400000);
	const filter = scoped(account, { newsletterId: newsletter._id });
	const [allStates, allChanges, allInvoices, allContacts, allGroups] = await Promise.all([
		SubscriptionFinancial.find(filter).sort({ _id: 1 }).limit(REVENUE_SCAN_LIMITS.subscriptions + 1).select("subscriptionId state firstObservedAt observedAt pendingChanges").lean(),
		SubscriptionChange.find({ ...filter, at: { $gte: from, $lte: now } }).sort({ at: 1, _id: 1 }).limit(REVENUE_SCAN_LIMITS.changes + 1).select("eventKey subscriptionId before after at").lean(),
		SubscriptionInvoice.find({ ...filter, paidAt: { $gte: from, $lte: now } }).sort({ paidAt: 1, _id: 1 }).limit(REVENUE_SCAN_LIMITS.invoices + 1).select("currency amountPaidMinor totalExTaxMinor postPaymentCreditsMinor paidOutOfBand paidAt observedAt").lean(),
		Contact.find({ ...filter, stripeSubscriptionId: { $type: "string" } }).sort({ _id: 1 }).limit(REVENUE_SCAN_LIMITS.subscriptions + 1).select("stripeSubscriptionId").lean(),
		GroupSubscription.find({ ...filter, stripeSubscriptionId: { $type: "string" } }).sort({ _id: 1 }).limit(REVENUE_SCAN_LIMITS.subscriptions + 1).select("stripeSubscriptionId").lean(),
	]);
	const states = allStates.slice(0, REVENUE_SCAN_LIMITS.subscriptions);
	const invoices = allInvoices.slice(0, REVENUE_SCAN_LIMITS.invoices);
	const limited = allStates.length > REVENUE_SCAN_LIMITS.subscriptions || allChanges.length > REVENUE_SCAN_LIMITS.changes || allInvoices.length > REVENUE_SCAN_LIMITS.invoices || (allContacts.length > REVENUE_SCAN_LIMITS.subscriptions || allGroups.length > REVENUE_SCAN_LIMITS.subscriptions) || states.some((row) => row.pendingChanges?.length > 8);
	const changesByKey = new Map(allChanges.slice(0, REVENUE_SCAN_LIMITS.changes).map((change) => [change.eventKey, change]));
	for (const row of states) for (const change of (row.pendingChanges ?? []).slice(0, 8)) {
		if (+new Date(change.at) >= +from && +new Date(change.at) <= +now && !changesByKey.has(change.eventKey)) changesByKey.set(change.eventKey, { ...change, subscriptionId: row.subscriptionId });
	}
	const changes = [...changesByKey.values()].sort((a, b) => +new Date(a.at) - +new Date(b.at) || a.eventKey.localeCompare(b.eventKey));
	const knownIds = new Set(states.map((row) => row.subscriptionId));
	const untrackedSubscriptions = allStates.length > REVENUE_SCAN_LIMITS.subscriptions || (allContacts.length > REVENUE_SCAN_LIMITS.subscriptions || allGroups.length > REVENUE_SCAN_LIMITS.subscriptions) ? null : [...new Set([...allContacts, ...allGroups].map((row) => row.stripeSubscriptionId))].filter((id) => !knownIds.has(id)).length;
	const groups = new Map(), reasons = new Map(), months = new Map();
	function group(currency) {
		const key = currency || "unknown";
		if (!groups.has(key)) groups.set(key, { currency: currency || null, observedSubscriptions: 0, recurringSubscriptions: 0, cancelAtPeriodEnd: 0, collectionPaused: 0, unknownMrr: 0, knownMonthlyRecurringMinor: 0, monthlyRecurringMinor: null, knownGrossMonthlyPriceMinor: 0, grossMonthlyPriceMinor: null, invoiceCount: 0, paidInvoiceMinor: null, invoiceTotalExTaxMinor: null, postPaymentCreditsMinor: null, markedPaidOutsideStripe: 0, unknownPaymentMethod: 0, _netKnown: 0, _grossKnown: 0, _grossMissing: false, _taxMissing: false, _creditsMissing: false });
		return groups.get(key);
	}
	for (const row of states) {
		const state = row.state ?? {}, entry = group(state.currency);
		entry.observedSubscriptions++; if (state.recurring) entry.recurringSubscriptions++;
		if (state.cancelAtPeriodEnd) entry.cancelAtPeriodEnd++; if (state.collectionPaused) entry.collectionPaused++;
		if (finite(state.monthlyRecurringMinor)) { entry.knownMonthlyRecurringMinor += state.monthlyRecurringMinor; entry._netKnown++; }
		else { entry.unknownMrr++; reasons.set(state.reason || "snapshot_incomplete", (reasons.get(state.reason || "snapshot_incomplete") ?? 0) + 1); }
		if (finite(state.grossMonthlyMinor)) { entry.knownGrossMonthlyPriceMinor += state.grossMonthlyMinor; entry._grossKnown++; } else entry._grossMissing = true;
	}
	for (const invoice of invoices) {
		const entry = group(invoice.currency); entry.invoiceCount++; entry.paidInvoiceMinor = (entry.paidInvoiceMinor ?? 0) + invoice.amountPaidMinor;
		if (finite(invoice.totalExTaxMinor)) entry.invoiceTotalExTaxMinor = (entry.invoiceTotalExTaxMinor ?? 0) + invoice.totalExTaxMinor; else entry._taxMissing = true;
		if (finite(invoice.postPaymentCreditsMinor)) entry.postPaymentCreditsMinor = (entry.postPaymentCreditsMinor ?? 0) + invoice.postPaymentCreditsMinor; else entry._creditsMissing = true;
		if (invoice.paidOutOfBand === true) entry.markedPaidOutsideStripe++; else if (typeof invoice.paidOutOfBand !== "boolean") entry.unknownPaymentMethod++;
		const month = new Date(invoice.paidAt).toISOString().slice(0, 7), key = `${month}:${invoice.currency}`;
		if (!months.has(key)) months.set(key, { month, currency: invoice.currency, invoiceCount: 0, paidInvoiceMinor: 0 });
		const bucket = months.get(key); bucket.invoiceCount++; bucket.paidInvoiceMinor += invoice.amountPaidMinor;
	}
	const observedChanges = Object.fromEntries(CHANGE_KINDS.map((kind) => [kind, 0]));
	const firstChange = new Map();
	for (const change of changes) {
		if (!firstChange.has(change.subscriptionId)) firstChange.set(change.subscriptionId, change);
		const kind = classifySubscriptionChange(change.before, change.after); observedChanges[kind]++;
	}
	let cohortStart = 0, cohortLost = 0, cohortUnknown = 0;
	for (const row of states) {
		if (+new Date(row.firstObservedAt) >= +from) continue;
		const initial = firstChange.has(row.subscriptionId) ? firstChange.get(row.subscriptionId).before : row.state;
		if (!initial || !finite(initial.grossMonthlyMinor)) { cohortUnknown++; continue; }
		if (!initial.recurring || initial.grossMonthlyMinor <= 0) continue;
		cohortStart++; if (["canceled", "unpaid"].includes(row.state?.status)) cohortLost++;
	}
	const currencies = [...groups.values()].sort((a, b) => (a.currency || "").localeCompare(b.currency || "")).map((entry) => {
		entry.monthlyRecurringMinor = !limited && untrackedSubscriptions === 0 && entry.observedSubscriptions && !entry.unknownMrr && entry.currency ? entry.knownMonthlyRecurringMinor : null;
		entry.grossMonthlyPriceMinor = !limited && untrackedSubscriptions === 0 && entry.observedSubscriptions && !entry._grossMissing && entry.currency ? entry.knownGrossMonthlyPriceMinor : null;
		if (!entry.observedSubscriptions || !entry.currency) { entry.knownMonthlyRecurringMinor = null; entry.knownGrossMonthlyPriceMinor = null; }
		if (!entry._netKnown) entry.knownMonthlyRecurringMinor = null;
		if (!entry._grossKnown) entry.knownGrossMonthlyPriceMinor = null;
		if (limited) entry.paidInvoiceMinor = null;
		if (limited || entry._taxMissing) entry.invoiceTotalExTaxMinor = null;
		if (limited || entry._creditsMissing) entry.postPaymentCreditsMinor = null;
		return Object.fromEntries(Object.entries(entry).filter(([key]) => !key.startsWith("_")));
	});
	const dates = states.map((row) => +new Date(row.observedAt));
	const firstDates = states.map((row) => +new Date(row.firstObservedAt));
	return {
		from: from.toISOString(), to: now.toISOString(), days, basis: REVENUE_BASIS,
		coverage: { historicalComplete: false, limited, untrackedSubscriptions, observedSubscriptions: states.length, observedInvoices: invoices.length, observedChanges: changes.length, firstObservedAt: firstDates.length ? new Date(Math.min(...firstDates)).toISOString() : null, oldestSubscriptionObservationAt: dates.length ? new Date(Math.min(...dates)).toISOString() : null, latestSubscriptionObservationAt: dates.length ? new Date(Math.max(...dates)).toISOString() : null },
		currencies, monthlyInvoices: [...months.values()].sort((a, b) => a.month.localeCompare(b.month) || a.currency.localeCompare(b.currency)),
		observedChanges, trackedCohort: { startingSubscriptions: cohortStart, endedCanceledOrUnpaid: cohortLost, unknownBaseline: cohortUnknown, lossRate: !limited && !cohortUnknown && cohortStart > 0 ? cohortLost / cohortStart : null },
		unknownReasons: [...reasons].map(([reason, count]) => ({ reason, count })),
	};
}

function cell(value) {
	if (value == null) return "";
	const text = String(value); return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
export function subscriptionRevenueCsv(report) {
	const fields = ["currency", "observedSubscriptions", "recurringSubscriptions", "knownMonthlyRecurringMinor", "monthlyRecurringMinor", "knownGrossMonthlyPriceMinor", "grossMonthlyPriceMinor", "unknownMrr", "invoiceCount", "paidInvoiceMinor", "invoiceTotalExTaxMinor", "postPaymentCreditsMinor", "markedPaidOutsideStripe", "unknownPaymentMethod"];
	return `${[fields, ...report.currencies.map((row) => fields.map((key) => row[key])), [], ["from", report.from], ["to", report.to], ["historicalComplete", false], ["limited", report.coverage.limited], ["untrackedSubscriptions", report.coverage.untrackedSubscriptions], ["basis", report.basis], [], ["observedChange", "count"], ...Object.entries(report.observedChanges), [], ["trackedCohortStart", report.trackedCohort.startingSubscriptions], ["trackedCohortLost", report.trackedCohort.endedCanceledOrUnpaid], ["trackedCohortLossRate", report.trackedCohort.lossRate], [], ["month", "currency", "observedInvoices", "paidInvoiceMinor"], ...report.monthlyInvoices.map((row) => [row.month, row.currency, row.invoiceCount, row.paidInvoiceMinor])].map((row) => row.map(cell).join(",")).join("\r\n")}\r\n`;
}
