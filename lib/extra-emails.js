import "server-only";
import { sendAlert } from "@/lib/alerts";
import { connectDb } from "@/lib/db";
import { formatNumber, formatUsdCents } from "@/lib/format";
import { EXTRA_EMAILS, getExtraEmailsCost, getExtraEmailsLimit } from "@/lib/plans";
import { EXTRA_EMAILS_EVENT, ingestEvents, isPolarConfigured } from "@/lib/polar";
import ExtraEmailUsage from "@/models/ExtraEmailUsage";

// Extra emails, counted per month of the account's plan (models/ExtraEmailUsage.js) as batches send them (lib/sending.js)
// and reported to Polar as usage events, which its meter sums and bills with the plan at the end of the period.
//
// Polar bills an event in the period it receives it, so reports go out soon after the sends: from the send path at most
// every REPORT_EVERY_MS per account, and from the hourly cron for whatever is left. A report covers a range of the
// month's count, [reported, counted), and its event id is made from that range: claimed before it's sent and settled
// after Polar answers, so a failed or repeated report is sent again with the same id, and Polar skips a duplicate.
const REPORT_EVERY_MS = 5 * 60_000;
const DUE_PER_RUN = 200;
const WARN_RATIO = 0.8;

export function getEventId(usage, from, to) {
	return `fs_extra_${usage.accountId}_${new Date(usage.periodStart).getTime()}_${from}_${to}`;
}

// Adds a batch's extra emails to its month, then tells the owner when they near the limit and reports to Polar if it's
// time. Only extra campaign, welcome and automation emails count: confirmation emails are never billed. isLimitReached:
// the batch found no room left, extra emails included, which is when sending stops. Only the count can throw: an alert
// or a report that fails is logged and tried again later.
export async function recordExtraEmails(account, count, { isLimitReached = false, now = new Date() } = {}) {
	const periodStart = account?.usage?.periodStart;
	if ((!(count > 0) && !isLimitReached) || !periodStart || !getExtraEmailsLimit(account)) return null;
	await connectDb();
	const usage = await ExtraEmailUsage.findOneAndUpdate(
		{ accountId: account._id, periodStart },
		{ $inc: { counted: Math.max(0, count) }, $set: { ...(count > 0 && { due: true }), ...(account.usage.periodEnd && { periodEnd: account.usage.periodEnd }) } },
		{ upsert: true, returnDocument: "after" }
	).lean();
	try {
		await alertNearLimit(account, usage, isLimitReached);
	} catch (error) {
		console.error(`[extra-emails] Couldn't tell account ${account._id} about its extra emails:`, error.message);
	}
	if (usage.due && (!usage.reportedAt || now - new Date(usage.reportedAt) >= REPORT_EVERY_MS)) {
		try {
			await reportExtraEmails(usage, now);
		} catch (error) {
			console.error(`[extra-emails] Couldn't report account ${account._id}'s extra emails to Polar; the hourly job tries again:`, error.message);
		}
	}
	return usage;
}

// Once a month each: at 80% of the limit, and when it's reached and sending stops.
async function alertNearLimit(account, usage, isLimitReached) {
	const limit = getExtraEmailsLimit(account);
	const reached = isLimitReached || usage.counted >= limit;
	if (!reached && usage.counted < limit * WARN_RATIO) return;
	const field = reached ? "reachedAt" : "warnedAt";
	const { modifiedCount } = await ExtraEmailUsage.updateOne(
		{ accountId: account._id, _id: usage._id, [field]: null },
		{ $set: { [field]: new Date(), ...(reached && !usage.warnedAt && { warnedAt: new Date() }) } }
	);
	if (!modifiedCount) return;
	const cost = formatUsdCents(getExtraEmailsCost(usage.counted));
	const sent = `${formatNumber(usage.counted)} of your ${formatNumber(limit)} extra emails this month (about ${cost} so far, at ${formatUsdCents(EXTRA_EMAILS.pricePerThousand)} per 1,000)`;
	await sendAlert({
		accountId: account._id,
		key: `extra-emails-${field}`,
		title: reached ? "You've reached your extra emails limit" : "You've used 80% of your extra emails limit",
		detail: reached
			? `You've sent ${sent}. Campaigns and welcome emails pause until your emails reset, you raise the limit, or you upgrade.`
			: `You've sent ${sent}. Sending stops at the limit, which you can change on the billing page.`,
		path: "/billing",
		cooldownMinutes: 0,
	});
}

// Reports what Polar hasn't had yet of one month, first finishing a report left pending. Returns how many it reported.
export async function reportExtraEmails(usage, now = new Date()) {
	if (!isPolarConfigured()) return 0;
	let current = usage;
	if (current.pending?.to === undefined || current.pending?.to === null) {
		if (current.counted <= current.reported) {
			await clearDue(current);
			return 0;
		}
		current = await ExtraEmailUsage.findOneAndUpdate(
			{ accountId: current.accountId, _id: current._id, reported: current.reported, "pending.to": null },
			{ $set: { pending: { from: current.reported, to: current.counted, at: now } } },
			{ returnDocument: "after" }
		).lean();
		// Another report claimed it first and sends it.
		if (!current) return 0;
	}
	const { from, to } = current.pending;
	await ingestEvents([
		{
			name: EXTRA_EMAILS_EVENT,
			external_customer_id: String(current.accountId),
			external_id: getEventId(current, from, to),
			timestamp: now.toISOString(),
			metadata: { count: to - from, period_start: new Date(current.periodStart).toISOString() },
		},
	]);
	const settled = await ExtraEmailUsage.findOneAndUpdate(
		{ accountId: current.accountId, _id: current._id, "pending.from": from, "pending.to": to },
		{ $set: { reported: to, reportedAt: now }, $unset: { pending: 1 } },
		{ returnDocument: "after" }
	).lean();
	if (settled) await clearDue(settled);
	return settled ? to - from : 0;
}

// Off the hourly job's list, unless a batch counted more since it was read.
async function clearDue(usage) {
	if (usage.counted > usage.reported || usage.pending?.to != null) return;
	await ExtraEmailUsage.updateOne(
		{ accountId: usage.accountId, _id: usage._id, counted: usage.counted, reported: usage.reported, "pending.to": null },
		{ $unset: { due: 1 } }
	);
}

// The hourly cron: every month with extra emails Polar hasn't had, oldest first, each on its own.
export async function reportDueExtraEmails(now = new Date()) {
	if (!isPolarConfigured()) return { reported: 0, failed: 0 };
	await connectDb();
	const due = await ExtraEmailUsage.find({ due: true }).setOptions({ crossAccount: true }).sort({ periodStart: 1 }).limit(DUE_PER_RUN).lean();
	let reported = 0;
	let failed = 0;
	for (const usage of due) {
		try {
			reported += await reportExtraEmails(usage, now);
		} catch (error) {
			failed++;
			console.error(`[extra-emails] Couldn't report account ${usage.accountId}'s extra emails to Polar:`, error.message);
		}
	}
	return { reported, failed };
}

// This month's extra emails, for the billing page, get_billing and the usage everywhere else.
export async function countExtraEmails(account) {
	const periodStart = account?.usage?.periodStart;
	if (!periodStart) return 0;
	const usage = await ExtraEmailUsage.findOne({ accountId: account._id, periodStart }).select({ counted: 1 }).lean();
	return usage?.counted ?? 0;
}
