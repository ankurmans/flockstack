import "server-only";
import * as z from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { findNewsletter, newsletterInput } from "@/lib/actions/shared";
import { getSubscriptionRevenueReport, subscriptionRevenueCsv } from "@/lib/subscription-revenue-report";
import { refreshSubscriptionRevenue } from "@/lib/subscription-revenue-refresh";

const group = "Reports";
const Money = z.number().nullable().describe("In this currency's smallest unit; monthly normalization can be fractional. Null means unknown or incomplete, not zero.");
const Fields = { newsletter: newsletterInput, days: z.number().int().min(1).max(730).optional().describe("Rolling days through now, 30 by default, at most 730. Dates and buckets use UTC.") };
const Report = z.object({
	from: z.string(), to: z.string(), days: z.number(), basis: z.string(),
	coverage: z.object({ historicalComplete: z.literal(false), limited: z.boolean(), untrackedSubscriptions: z.number().nullable(), observedSubscriptions: z.number(), observedInvoices: z.number(), observedChanges: z.number(), firstObservedAt: z.string().nullable(), oldestSubscriptionObservationAt: z.string().nullable(), latestSubscriptionObservationAt: z.string().nullable() }),
	currencies: z.array(z.object({ currency: z.string().nullable(), observedSubscriptions: z.number(), recurringSubscriptions: z.number(), cancelAtPeriodEnd: z.number(), collectionPaused: z.number(), unknownMrr: z.number(), knownMonthlyRecurringMinor: Money, monthlyRecurringMinor: Money, knownGrossMonthlyPriceMinor: Money, grossMonthlyPriceMinor: Money, invoiceCount: z.number(), paidInvoiceMinor: Money, invoiceTotalExTaxMinor: Money, postPaymentCreditsMinor: Money, markedPaidOutsideStripe: z.number(), unknownPaymentMethod: z.number() })),
	monthlyInvoices: z.array(z.object({ month: z.string(), currency: z.string(), invoiceCount: z.number(), paidInvoiceMinor: z.number() })),
	observedChanges: z.object(Object.fromEntries(["first_seen", "activated", "reactivated", "upgraded", "downgraded", "expanded", "contracted", "churn", "paused", "currency_changed", "plan_changed", "updated"].map((key) => [key, z.number()]))),
	trackedCohort: z.object({ startingSubscriptions: z.number(), endedCanceledOrUnpaid: z.number(), unknownBaseline: z.number(), lossRate: z.number().nullable() }),
	unknownReasons: z.array(z.object({ reason: z.string(), count: z.number() })),
});
const read = defineAction({
	name: "get_subscription_revenue_report", title: "Get subscription revenue report", group,
	description: "Reports observed Stripe subscription invoices, latest observed MRR, tier upgrade/downgrade and churn observations, and loss within the tracked starting cohort. Each currency is separate. Uses current Stripe price snapshots, never today's newsletter list prices. Invoices may include credit and payments marked paid outside Stripe; these totals are not cash, net revenue or payouts. History is incomplete; null means unknown. Scan limits and untracked subscriptions are explicit. Reading never calls Stripe. Use refresh_subscription_revenue to update known subscriptions, and account export for underlying financial records.",
	http: { method: "GET", path: "/reports/revenue" }, readOnly: true,
	input: z.object(Fields), output: Report,
	handler: async ({ account, input }) => getSubscriptionRevenueReport({ account, newsletter: await findNewsletter(account, input.newsletter, "accountId"), days: input.days ?? 30 }),
});
const exportReport = defineAction({
	name: "export_subscription_revenue_report", title: "Export subscription revenue report", group,
	description: "Exports the same observed financial report as CSV, with currencies, minor-unit amounts, monthly paid invoice totals, tracked changes and cohort values, and its coverage/basis. Unknown values are blank, never invented zero. No contact names or email addresses. This is not an accounting or payout export; private account export contains the underlying invoice/subscription source IDs.",
	http: { method: "GET", path: "/reports/revenue/export" }, readOnly: true,
	input: z.object(Fields), output: z.object({ filename: z.string(), contentType: z.literal("text/csv; charset=utf-8"), csv: z.string() }),
	handler: async ({ account, input }) => {
		const report = await getSubscriptionRevenueReport({ account, newsletter: await findNewsletter(account, input.newsletter, "accountId"), days: input.days ?? 30 });
		return { filename: `subscription-revenue-${report.to.slice(0, 10)}.csv`, contentType: "text/csv; charset=utf-8", csv: subscriptionRevenueCsv(report) };
	},
});
const refresh = defineAction({
	name: "refresh_subscription_revenue", title: "Refresh subscription revenue", group,
	description: "Reads up to 20 known individual or group subscriptions from your Stripe account and saves normalized financial snapshots, plus at most the latest paid invoice per subscription. Resolves supported discount references with at most ten coupon reads per page and a bounded provider-read time. Validates FlockStack metadata or an existing import mapping before discount reads and after an expanded subscription read. Follow the cursor to continue; duplicate subscriptions in a page are read once. Does not enumerate all Stripe subscriptions or backfill older invoices. Changes no Stripe setting, charge, reader access or subscription and sends no email. This writes local report data, so it needs write permission. The page does not call it automatically.",
	http: { method: "POST", path: "/reports/revenue/refresh" }, openWorld: true, whileBlocked: true, rateLimit: { limit: 120, window: "1 h" },
	input: z.object({ newsletter: newsletterInput, cursor: z.string().max(100).optional().describe("The next cursor from the previous refresh; omit to start with the first known contact, then groups") }),
	output: z.object({ contactsScanned: z.number(), groupsScanned: z.number(), subscriptionsObserved: z.number(), skipped: z.number(), invoicesRecorded: z.number(), timeLimited: z.boolean(), cursor: z.string().nullable(), basis: z.string() }),
	handler: async ({ account, input }) => refreshSubscriptionRevenue({ account, newsletter: await findNewsletter(account, input.newsletter), cursor: input.cursor }),
});
export const subscriptionRevenueActions = [read, exportReport, refresh];
