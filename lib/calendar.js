import { scoped } from "@/lib/account-scope";
import { resolveTimeZone, shiftDateKey, startOfDateKey, toDateKey } from "@/lib/time-zone";
import Campaign from "@/models/Campaign";

// The issues of one month for the content calendar: scheduled ones on the time they go out, the others (sending, paused,
// sent, imported) on the day they went out. Drafts have no day and aren't on it.
export const CALENDAR_STATUSES = ["scheduled", "sending", "paused", "sent"];
const MAX_ISSUES = 500;

export function isMonthKey(value) {
	return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value ?? ""));
}

export function shiftMonthKey(month, delta) {
	const [year, number] = month.split("-").map(Number);
	const date = new Date(Date.UTC(year, number - 1 + delta, 1));
	return date.toISOString().slice(0, 7);
}

// The first and last day of the month's weeks as a calendar shows them: Monday to Sunday, so a month's grid is whole weeks.
export function getMonthGrid(month) {
	const first = `${month}-01`;
	const lastDay = shiftDateKey(`${shiftMonthKey(month, 1)}-01`, -1);
	const lead = (new Date(`${first}T12:00:00Z`).getUTCDay() + 6) % 7;
	const trail = 6 - ((new Date(`${lastDay}T12:00:00Z`).getUTCDay() + 6) % 7);
	return { first, lastDay, start: shiftDateKey(first, -lead), end: shiftDateKey(lastDay, trail) };
}

// The month, in the given timezone, with each issue on its local day.
export async function getCalendar(account, { month, timeZone, newsletterId } = {}) {
	const zone = resolveTimeZone(timeZone);
	const key = isMonthKey(month) ? month : toDateKey(new Date(), zone).slice(0, 7);
	const from = startOfDateKey(`${key}-01`, zone);
	const to = startOfDateKey(`${shiftMonthKey(key, 1)}-01`, zone);
	const inRange = { $gte: from, $lt: to };
	const issues = await Campaign.find(
		scoped(account, {
			...(newsletterId && { newsletterId }),
			$or: [
				{ status: "scheduled", scheduledAt: inRange },
				{ status: { $in: ["sending", "paused", "sent"] }, sentAt: inRange },
				{ status: { $in: ["sending", "paused", "sent"] }, sentAt: { $exists: false }, startedAt: inRange },
			],
		})
	)
		.select({ subject: 1, status: 1, scheduledAt: 1, startedAt: 1, sentAt: 1, newsletterId: 1, publishTo: 1, "stats.recipients": 1 })
		.sort({ _id: 1 })
		.limit(MAX_ISSUES)
		.lean();

	const entries = issues
		.map((campaign) => {
			const at = campaign.status === "scheduled" ? campaign.scheduledAt : (campaign.sentAt ?? campaign.startedAt);
			return {
				id: String(campaign._id),
				newsletterId: String(campaign.newsletterId),
				subject: campaign.subject ?? "",
				status: campaign.status,
				publishTo: campaign.publishTo ?? "both",
				recipients: campaign.stats?.recipients ?? 0,
				at,
				date: toDateKey(at, zone),
			};
		})
		.filter(({ at }) => at >= from && at < to)
		.toSorted((a, b) => a.at - b.at);

	const days = new Map();
	for (const entry of entries) days.set(entry.date, [...(days.get(entry.date) ?? []), entry]);
	return { month: key, timeZone: zone, from, to, entries, days };
}
